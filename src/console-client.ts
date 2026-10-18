// otto/mamoru-astro#24: the console's client. Draws `.c-chart[data-c]` at the container's real width (so 11px labels
// stay 11px at every size), with a hover readout; opens the account drawer from any `[data-account]`; keeps the
// theme. It listens for the router's "ops:mounted" event, so it works on first paint and after every fragment swap.
// Plain ES5-style JS inside a template literal: no backticks and no ${} in the script body.

/** Runs in <head>, before first paint: the saved theme, so the page never flashes the wrong one. */
export function themeHeadScript(nonce: string): string {
  return `<script nonce="${nonce}">try{var t=localStorage.getItem("ops-theme");if(t==="dark"||t==="light")document.documentElement.setAttribute("data-theme",t)}catch(e){}</script>`;
}

export function consoleClientScript(nonce: string): string {
  return `<script nonce="${nonce}">
(function () {
  var NS = "http://www.w3.org/2000/svg";
  function sv(tag, a, p) { var n = document.createElementNS(NS, tag); for (var k in a) n.setAttribute(k, a[k]); if (p) p.appendChild(n); return n; }
  function txt(p, x, y, s, anchor, cls) { var t = sv("text", { x: x, y: y, "text-anchor": anchor || "start" }, p); if (cls) t.setAttribute("class", cls); t.textContent = s; return t; }
  function money(v) {
    var a = Math.abs(v), s = v < 0 ? "-" : "";
    if (a === 0) return "$0";
    if (a < 0.001) return s + "<0.1\\u00a2";
    if (a < 1) return s + (a * 100).toFixed(a < 0.1 ? 1 : 0) + "\\u00a2";
    if (a < 10000) return s + "$" + a.toLocaleString("en-US", { minimumFractionDigits: a < 100 ? 2 : 0, maximumFractionDigits: a < 100 ? 2 : 0 });
    return s + "$" + (a / 1000).toFixed(1) + "K";
  }
  var FMT = {
    money: money,
    k: function (v) { return v >= 1000 ? Math.round(v / 1000) + "K" : String(Math.round(v)); },
    "int": function (v) { return Math.round(v).toLocaleString("en-US"); }
  };
  function niceMax(v) {
    if (!(v > 0)) return 1;
    var e = Math.pow(10, Math.floor(Math.log10(v))), m = v / e;
    var steps = [1, 1.5, 2, 3, 4, 5, 6, 8, 10];
    for (var i = 0; i < steps.length; i++) if (m <= steps[i]) return steps[i] * e;
    return 10 * e;
  }
  function tipOf(host) {
    var t = host.querySelector(".c-tip");
    if (!t) { t = document.createElement("div"); t.className = "c-tip"; host.appendChild(t); }
    return t;
  }
  function showTip(host, t, xPct, yPx, value, label) {
    t.textContent = "";
    var b = document.createElement("b"); b.textContent = value; var s = document.createElement("span"); s.textContent = label;
    t.appendChild(b); t.appendChild(s);
    t.style.left = xPct + "%"; t.style.top = yPx + "px"; t.classList.add("on");
  }
  function grid(svg, W, L, R, T, H, B, max, fmt, rows) {
    for (var i = 0; i <= rows; i++) {
      var v = max * i / rows, y = T + (H - T - B) * (1 - v / max);
      sv("line", { x1: L, x2: W - R, y1: y, y2: y, "class": i ? "gl" : "ax" }, svg);
      txt(svg, L - 8, y + 4, fmt(v), "end");
    }
  }
  function line(host, spec, W) {
    var H = parseInt(getComputedStyle(host).getPropertyValue("--h"), 10) || 180, L = 52, R = 12, T = 14, B = 26;
    var pts = spec.points, n = pts.length, fmt = FMT[spec.fmt] || money;
    var svg = sv("svg", { viewBox: "0 0 " + W + " " + H, width: W, height: H, "class": "c-svg tone-" + (spec.color || "emerald") });
    var max = niceMax(Math.max.apply(null, pts.map(function (p) { return p.y; }).concat(spec.threshold ? [spec.threshold.y] : [])) * 1.08);
    var lead = max / Math.pow(10, Math.floor(Math.log10(max)));
    grid(svg, W, L, R, T, H, B, max, fmt, lead === 1.5 || lead === 3 || lead === 6 ? 3 : lead === 1 || lead === 5 || lead === 10 ? 5 : 4);
    function x(i) { return L + (W - L - R) * (n < 2 ? 0.5 : i / (n - 1)); }
    function y(v) { return T + (H - T - B) * (1 - v / max); }
    var every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(W / 110))));
    for (var i = 0; i < n; i++) if (i % every === 0 || i === n - 1) { if (i !== n - 1 && n - 1 - i < every * 0.6) continue; txt(svg, x(i), H - 7, pts[i].l, i === 0 ? "start" : i === n - 1 ? "end" : "middle"); }
    var d = ""; for (var j = 0; j < n; j++) d += (j ? "L" : "M") + x(j).toFixed(1) + " " + y(pts[j].y).toFixed(1);
    sv("path", { d: d + "L" + x(n - 1) + " " + y(0) + "L" + x(0) + " " + y(0) + "Z", "class": "area" }, svg);
    sv("path", { d: d, "class": "stroke" }, svg);
    if (spec.threshold) { var ty = y(spec.threshold.y); sv("line", { x1: L, x2: W - R, y1: ty, y2: ty, "class": "thr" }, svg); txt(svg, L + 6, ty - 6, spec.threshold.label, "start", "thr-l"); }
    sv("circle", { cx: x(n - 1), cy: y(pts[n - 1].y), r: 4, "class": "end" }, svg);
    var cross = sv("line", { y1: T, y2: H - B, "class": "c-cross" }, svg);
    var hit = sv("rect", { x: L, y: 0, width: W - L - R, height: H - B, fill: "transparent" }, svg);
    host.appendChild(svg);
    var t = tipOf(host);
    hit.addEventListener("pointermove", function (e) {
      var r = svg.getBoundingClientRect(), px = (e.clientX - r.left) / r.width * W;
      var i = Math.max(0, Math.min(n - 1, Math.round((px - L) / (W - L - R) * (n - 1))));
      cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.classList.add("on");
      showTip(host, t, x(i) / W * 100, y(pts[i].y), fmt(pts[i].y), pts[i].l);
    });
    hit.addEventListener("pointerleave", function () { t.classList.remove("on"); cross.classList.remove("on"); });
  }
  function bars(host, spec, W) {
    var H = parseInt(getComputedStyle(host).getPropertyValue("--h"), 10) || 150, L = 34, R = 8, T = 10, B = 24;
    var pts = spec.points, n = pts.length, fmt = FMT[spec.fmt] || FMT["int"], stack = spec.stack;
    var tot = pts.map(function (p) { if (!stack) return p.y || 0; var s = 0; for (var k = 0; k < stack.length; k++) s += (p.s && p.s[stack[k].key]) || 0; return s; });
    var max = niceMax(Math.max.apply(null, tot.concat([1])));
    var svg = sv("svg", { viewBox: "0 0 " + W + " " + H, width: W, height: H, "class": "c-svg tone-" + (spec.color || "emerald") });
    grid(svg, W, L, R, T, H, B, max, fmt, 2);
    function y(v) { return T + (H - T - B) * (1 - v / max); }
    var bw = (W - L - R) / n, w = Math.max(2, Math.min(16, bw * 0.62));
    var every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(W / 80))));
    var t = tipOf(host);
    pts.forEach(function (p, i) {
      var cx = L + bw * i + bw / 2, base = 0;
      var parts = stack ? stack.map(function (k) { return { v: (p.s && p.s[k.key]) || 0, c: k.color }; }) : [{ v: p.y || 0, c: "" }];
      parts.forEach(function (q) {
        if (!q.v) return;
        var y0 = y(base), y1 = y(base + q.v);
        sv("rect", { x: cx - w / 2, y: y1, width: w, height: Math.max(1.5, y0 - y1 - (base ? 2 : 0)), rx: 2, "class": "c-b" + (q.c ? " t-" + q.c : "") }, svg);
        base += q.v;
      });
      if (i % every === 0 || i === n - 1) { if (!(i !== n - 1 && n - 1 - i < every * 0.6)) txt(svg, cx, H - 7, p.l, "middle"); }
      var hit = sv("rect", { x: cx - bw / 2, y: 0, width: bw, height: H - B, fill: "transparent" }, svg);
      hit.addEventListener("pointermove", function () {
        var v = stack ? stack.filter(function (k) { return p.s && p.s[k.key]; }).map(function (k) { return k.name + " " + fmt(p.s[k.key]); }).join(", ") || "none" : fmt(p.y || 0);
        showTip(host, t, cx / W * 100, y(tot[i]), v, p.l);
      });
      hit.addEventListener("pointerleave", function () { t.classList.remove("on"); });
    });
    host.appendChild(svg);
  }
  function draw(scope) {
    var hosts = scope.querySelectorAll(".c-chart[data-c]");
    for (var i = 0; i < hosts.length; i++) {
      var h = hosts[i], W = Math.max(260, Math.round(h.clientWidth));
      if (h._w === W) continue;
      h._w = W;
      var spec; try { spec = JSON.parse(h.getAttribute("data-c")); } catch (e) { continue; }
      while (h.firstChild) h.removeChild(h.firstChild);
      if (!spec.points || !spec.points.length) continue;
      if (spec.t === "line") line(h, spec, W); else bars(h, spec, W);
    }
  }

  // ---- account drawer ----
  var drawer = document.getElementById("c-drawer"), scrim = document.getElementById("c-scrim"), lastFocus = null;
  function openAccount(key) {
    var tpl = document.getElementById("c-acct-" + key);
    if (!tpl || !drawer) return;
    var body = drawer.querySelector(".c-drawer-body");
    while (body.firstChild) body.removeChild(body.firstChild);
    body.appendChild(tpl.content.cloneNode(true));
    lastFocus = document.activeElement;
    document.documentElement.classList.add("c-drawer-open");
    drawer.removeAttribute("hidden"); drawer.setAttribute("aria-hidden", "false");
    var close = drawer.querySelector(".c-close"); if (close) close.focus();
  }
  function closeDrawer() {
    if (!drawer || drawer.getAttribute("aria-hidden") === "true") return;
    document.documentElement.classList.remove("c-drawer-open");
    drawer.setAttribute("aria-hidden", "true");
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("[data-account]");
    if (a && !a.closest("#c-drawer")) { e.preventDefault(); openAccount(a.getAttribute("data-account")); return; }
    if (e.target.closest && e.target.closest(".c-close")) closeDrawer();
  });
  if (scrim) scrim.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeDrawer(); });

  // ---- theme ----
  var tb = document.getElementById("c-theme");
  function current() { var t = document.documentElement.getAttribute("data-theme"); if (t) return t; return window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; }
  function label() { if (tb) tb.textContent = current() === "dark" ? "Paper" : "Night"; }
  if (tb) tb.addEventListener("click", function () {
    var next = current() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("ops-theme", next); } catch (e) {}
    label();
    var hosts = document.querySelectorAll(".c-chart"); for (var i = 0; i < hosts.length; i++) hosts[i]._w = 0;
    draw(document);
  });
  label();

  function mounted(scope) { closeDrawer(); draw(scope || document); }
  document.addEventListener("ops:mounted", function (e) { mounted(e.detail && e.detail.scope); });
  var rt; window.addEventListener("resize", function () { clearTimeout(rt); rt = setTimeout(function () { draw(document); }, 120); });
  mounted(document);
})();
</script>`;
}
