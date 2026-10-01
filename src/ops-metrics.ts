/** Renders /ops, the metrics overview. Pure string building over an Overview model. */

import { renderBars, renderFunnel, renderTally, renderTimeChart } from "./metrics-charts";
import { dauSlots, fmtInt, fmtUsd, shortDay } from "./metrics-math";
import { DAU_DAYS, type Change, type Overview } from "./metrics-overview";
import { opsShell, renderNav } from "./ops";
import { esc } from "./text";

const STYLE = `
:root {
  --rice: #f8f5ef; --paper: #f4f0e6; --ink: #0f0f0e; --wash: #d9d2c3;
  --emerald: #2f5d50; --stone: #8a8578; --muted: #5d594f;
  --rule: rgba(15, 15, 14, 0.14); --rule-soft: rgba(15, 15, 14, 0.07);
  --out: cubic-bezier(0.2, 0.8, 0.2, 1);
}
main.wide { max-width: 70rem; margin-inline: auto; box-sizing: border-box; padding: 2.5rem clamp(1.15rem, 4vw, 3rem) 4rem; }
main.wide .soft { color: var(--muted); }
main.wide a { text-underline-offset: 0.16em; }
main.wide a:focus-visible, main.wide button:focus-visible, main.wide summary:focus-visible { outline: 2px solid var(--emerald); outline-offset: 3px; }

.ov-head { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 0.4rem 1.5rem; margin: 0.8rem 0 1.5rem; }
.ov-head h1 { margin: 0; }
.asof { margin: 0; font-size: 0.9rem; color: var(--muted); }
button.link { background: none; color: var(--emerald); padding: 0; margin-left: 0.6rem; text-decoration: underline; text-underline-offset: 0.16em; }
button.link:hover { color: var(--ink); }
.notes { margin: -0.6rem 0 1.4rem; font-size: 0.95rem; }
.notes p { margin: 0 0 0.25rem; }

/* Headline figures: one ruled line of numerals, no boxes. */
.figs { margin: 0; border-top: 1px solid var(--rule); padding: 1.15rem 0 0.4rem; display: grid; grid-template-columns: minmax(0, 2.2fr) repeat(5, minmax(0, 1fr)); column-gap: clamp(1rem, 2.4vw, 2.2rem); align-items: baseline; }
.fig { display: contents; }
.fig > dt { grid-row: 1; grid-column: var(--c); font-size: 0.9rem; color: var(--muted); }
.fig > dd { margin: 0; grid-column: var(--c); }
.fig-n { grid-row: 2; font-size: 2.15rem; line-height: 1.15; letter-spacing: -0.01em; white-space: nowrap; }
.fig.lead .fig-n { font-size: clamp(3rem, 5.4vw, 4.3rem); line-height: 1; letter-spacing: -0.02em; }
.fig-n [data-n] { display: inline-block; }
.fig-n .of { font-size: 0.5em; color: var(--muted); letter-spacing: 0; margin-left: 0.3em; }
.fig-s { grid-row: 3; align-self: start; font-size: 0.85rem; line-height: 1.4; color: var(--muted); padding-top: 0.35rem; }
.fig-s span { display: block; text-wrap: balance; }

.cols { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); column-gap: clamp(2rem, 5vw, 4.5rem); margin-top: 2.1rem; }
.sec { border-top: 1px solid var(--rule); padding: 1.05rem 0 2.5rem; min-width: 0; }
.sec.full { grid-column: 1 / -1; }
.sec-head { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 0.3rem 1.4rem; }
.sec h2 { margin: 0; font-size: 1.15rem; }
.legend { display: flex; flex-wrap: wrap; gap: 0.2rem 1.2rem; margin: 0; padding: 0; list-style: none; font-size: 0.85rem; color: var(--muted); }
.legend b { font-weight: 400; color: var(--ink); margin-left: 0.3rem; }
.key { display: inline-block; width: 1.1rem; height: 0; border-top: 2px solid var(--ink); vertical-align: 0.28em; margin-right: 0.45rem; }
.key.k-emerald { border-color: var(--emerald); }
.key.dashed { border-top-style: dashed; }
.key.sw { width: 0.62rem; height: 0.62rem; border: 0; vertical-align: -0.02em; }
.key.sw-stone { background: rgba(138, 133, 120, 0.5); }
.key.sw-emerald { background: rgba(47, 93, 80, 0.45); }

.chart { margin-top: 1.25rem; }
.plot { position: relative; height: 13rem; margin: 0 0 1.9rem 2.9rem; }
.plot:focus-visible { outline: 2px solid var(--emerald); outline-offset: 6px; }
.layer { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.layer * { vector-effect: non-scaling-stroke; fill: none; }
.layer .rule { stroke: var(--rule-soft); stroke-width: 1; }
.layer .axis { stroke: rgba(15, 15, 14, 0.4); stroke-width: 1; }
.layer .area.a-stone { fill: rgba(138, 133, 120, 0.26); }
.layer .area.a-emerald { fill: rgba(47, 93, 80, 0.24); }
.layer .edge { stroke: rgba(15, 15, 14, 0.22); stroke-width: 1; }
.layer .line { stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }
.layer .l-ink { stroke: var(--ink); }
.layer .l-emerald { stroke: var(--emerald); }
.layer .l-stone { stroke: var(--stone); }
.layer .line.dashed { stroke-dasharray: 6 5; stroke-linecap: butt; }
.yt, .xt { position: absolute; font-size: 0.78rem; line-height: 1; color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.yt { right: calc(100% + 0.6rem); transform: translateY(-50%); }
.xt { top: calc(100% + 0.55rem); transform: translateX(-50%); }
.xt.first { transform: none; }
.xt.last { transform: translateX(-100%); }
.dot { position: absolute; width: 7px; height: 7px; margin: -5.5px 0 0 -5.5px; border-radius: 50%; background: var(--ink); border: 2px solid var(--rice); }
.dot.d-emerald { background: var(--emerald); }
.dot.d-stone { background: var(--stone); }
.stem { position: absolute; right: -1.5px; width: 3px; }
.stem.s-stone { background: var(--stone); }
.stem.s-emerald { background: var(--emerald); }
.stem.s-ink { background: var(--ink); }
.plot-note { position: absolute; left: 0; bottom: 0.7rem; margin: 0; max-width: 78%; font-size: 0.95rem; line-height: 1.4; color: var(--muted); }

.bar-row { position: absolute; inset: 0; display: flex; align-items: flex-end; }
.slot { flex: 1; height: 100%; display: flex; align-items: flex-end; justify-content: center; }
.bar { display: block; width: min(34%, 7px); background: var(--ink); }
.bar.today { background: var(--emerald); }
.bar.zero { height: 2px !important; background: var(--stone); }
.bar.rest { width: 1px; height: 7px; background: rgba(15, 15, 14, 0.38); }
.plot.idle .rule { display: none; }
.slot.on .bar { outline: 1px solid var(--ink); outline-offset: 2px; }

.cross { position: absolute; top: 0; bottom: 0; width: 0; border-left: 1px solid rgba(15, 15, 14, 0.45); opacity: 0; pointer-events: none; }
.tip { position: absolute; left: 0; top: 0; z-index: 2; pointer-events: none; opacity: 0; background: var(--ink); color: var(--paper); padding: 0.4rem 0.6rem 0.45rem; font-size: 0.8rem; line-height: 1.4; white-space: nowrap; transition: opacity 120ms ease; }
.cross.on, .tip.on { opacity: 1; }
.tip .tt { color: rgba(244, 240, 230, 0.72); }
.tip .tr { display: flex; justify-content: space-between; gap: 1.1rem; }
.tip .tr span:last-child { font-variant-numeric: tabular-nums; }
.tip .tr + .tr span:first-child { color: rgba(244, 240, 230, 0.72); }

.cap { margin: 0 0 0.3rem; font-size: 0.85rem; }
details.tbl { margin-top: 0.2rem; font-size: 0.85rem; }
details.tbl summary { cursor: pointer; color: var(--muted); width: fit-content; }
details.tbl table { margin-top: 0.4rem; max-width: 26rem; font-variant-numeric: tabular-nums; }
details.tbl th, details.tbl td { padding: 0.3rem 0.8rem 0.3rem 0; border-color: var(--rule); }
details.tbl th { color: var(--muted); font-size: inherit; }

.funnel { list-style: none; margin: 1.25rem 0 0; padding: 0; }
.step { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 1rem; align-items: baseline; padding-bottom: 1.2rem; }
.step-name { font-size: 1rem; }
.step-rate { margin-left: 0.55rem; font-size: 0.85rem; color: var(--muted); white-space: nowrap; }
.step-n { font-size: 1.5rem; line-height: 1; }
.step-track { grid-column: 1 / -1; display: block; height: 5px; margin-top: 0.5rem; border-bottom: 1px solid var(--rule); }
.step-bar { display: block; height: 100%; background: var(--ink); }

.runway { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; column-gap: clamp(1.5rem, 4vw, 3.5rem); align-items: center; margin-top: 1rem; }
.run-n { margin: 0; display: flex; align-items: baseline; gap: 0.7rem; }
.run-n .fig-n { font-size: 2.15rem; }
.run-s { margin: 0; text-align: right; font-size: 0.95rem; line-height: 1.5; }
.tally { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 0.55rem 6px; min-height: 1.1rem; }
.tick { display: block; width: 1.5px; height: 1.1rem; background: var(--ink); }
.tick.fifth { margin-right: 11px; }
.tally-more { font-size: 0.85rem; color: var(--muted); align-self: center; }

.ov-foot { border-top: 1px solid var(--rule); padding-top: 1.1rem; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem 1.5rem; font-size: 0.95rem; }
.ov-foot p, .ov-foot form { margin: 0; }
.ov-foot button.quiet { color: var(--muted); text-decoration: underline; text-underline-offset: 0.16em; }

@media (max-width: 1040px) {
  .figs { grid-template-columns: repeat(5, minmax(0, 1fr)); row-gap: 0; }
  .fig.lead > * { grid-column: 1 / -1; }
  .fig:not(.lead) > dt { grid-row: 4; grid-column: var(--m); padding-top: 1.3rem; }
  .fig:not(.lead) > .fig-n { grid-row: 5; grid-column: var(--m); }
  .fig:not(.lead) > .fig-s { grid-row: 6; grid-column: var(--m); }
}
@media (max-width: 860px) {
  .cols { grid-template-columns: minmax(0, 1fr); }
  .runway { grid-template-columns: minmax(0, 1fr); row-gap: 1rem; }
  .run-s { text-align: left; }
}
@media (max-width: 640px) {
  .figs { display: block; padding-bottom: 0; }
  .fig { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 1rem; align-items: baseline; padding: 0.75rem 0 0.8rem; border-top: 1px solid var(--rule); }
  .fig.lead { display: block; border-top: 0; padding: 0 0 1.2rem; }
  .fig:not(.lead) > dt { grid-row: 1; grid-column: 1; padding-top: 0; font-size: 1rem; color: var(--ink); }
  .fig:not(.lead) > .fig-n { grid-row: 1 / span 2; grid-column: 2; font-size: 1.7rem; text-align: right; }
  .fig:not(.lead) > .fig-s { grid-row: 2; grid-column: 1; padding-top: 0.1rem; }
  .cols { margin-top: 0; }
  .plot { height: 11rem; margin-left: 2.5rem; }
}

/* Motion: only under .js-motion, which the head script sets when motion is welcome. */
@keyframes mm-draw { to { stroke-dashoffset: 0; } }
@keyframes mm-reveal { from { clip-path: inset(-12px 100% -12px -12px); } to { clip-path: inset(-12px -12px -12px -12px); } }
@keyframes mm-pour-up { from { clip-path: inset(100% -4px -1px -4px); } to { clip-path: inset(-4px -4px -1px -4px); } }
@keyframes mm-pour-right { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0 0 0 0); } }
@keyframes mm-settle { from { opacity: 0; transform: scale(0.3); } }
.js-motion .sec:not(.in) :is(.layer.wash, .layer.ink, .layer.over, .dot, .stem, .bar, .step-bar, .tick) { opacity: 0; }
.js-motion .sec.in :is(.layer.wash, .layer.over) { animation: mm-reveal 1200ms var(--out) calc(var(--s, 0ms) + 160ms) both; }
.js-motion .sec.in .layer.ink .line:not(.done) { stroke-dasharray: var(--len, 4000); stroke-dashoffset: var(--len, 4000); animation: mm-draw 1200ms var(--out) calc(var(--s, 0ms) + 160ms) forwards; }
.js-motion .sec.in .dot { animation: mm-settle 360ms var(--out) calc(var(--s, 0ms) + 1150ms) both; }
.js-motion .sec.in .stem { animation: mm-pour-up 700ms var(--out) calc(var(--s, 0ms) + 200ms) both; }
.js-motion .sec.in .bar { animation: mm-pour-up 480ms var(--out) calc(var(--s, 0ms) + 160ms + var(--i, 0) * 38ms) both; }
.js-motion .sec.in .tick { animation: mm-pour-up 300ms var(--out) calc(var(--s, 0ms) + 200ms + var(--i, 0) * 24ms) both; }
.js-motion .sec.in .step-bar { animation: mm-pour-right var(--ms, 400ms) linear calc(var(--s, 0ms) + var(--d, 0ms)) both; }
.js-motion .sec.in .step-bar.pour-first { animation-timing-function: cubic-bezier(0.5, 0, 0.75, 0.75); }
.js-motion .sec.in .step-bar.pour-last { animation-timing-function: cubic-bezier(0.25, 0.25, 0.3, 1); }
@media (prefers-reduced-motion: reduce) {
  main.wide *, main.wide *::before, main.wide *::after { animation: none !important; transition: none !important; }
}
`;

/** Runs before first paint so nothing flashes in its final state and then restarts. */
function headScript(nonce: string): string {
  return `<script nonce="${nonce}">if(!window.matchMedia||!matchMedia("(prefers-reduced-motion: reduce)").matches)document.documentElement.classList.add("js-motion");</script>`;
}

/** Count-up, line draw lengths, scroll-in, and the hover/focus value label. No framework, no CDN. */
function bodyScript(nonce: string): string {
  return `<script nonce="${nonce}">
(function () {
  var root = document.documentElement;
  var moving = root.classList.contains("js-motion");
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function usd(v) {
    if (v >= 1e6) return "$" + (v / 1e6).toFixed(1) + "M";
    if (v >= 1e4) return "$" + (v / 1e3).toFixed(1) + "K";
    if (v >= 1e3) return "$" + Math.round(v).toLocaleString("en-US");
    return "$" + v.toFixed(2);
  }
  function show(kind, v) {
    if (kind === "usd") return usd(v);
    if (kind === "dec1") return v.toFixed(1);
    return Math.round(v).toLocaleString("en-US");
  }
  function countUp(node, delay) {
    var to = parseFloat(node.getAttribute("data-n"));
    var kind = node.getAttribute("data-f") || "int";
    var final = node.textContent;
    if (!(to > 0)) return;
    node.style.minWidth = node.offsetWidth + "px";
    node.textContent = show(kind, 0);
    var start = null;
    function frame(now) {
      if (start === null) start = now + delay;
      var t = Math.min(1, Math.max(0, (now - start) / 900));
      var eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
      if (t < 1) {
        node.textContent = show(kind, to * eased);
        requestAnimationFrame(frame);
      } else {
        node.textContent = final;
        node.style.minWidth = "";
      }
    }
    requestAnimationFrame(frame);
  }
  function lineLengths(scope) {
    var lines = scope.querySelectorAll(".layer.ink .line");
    for (var i = 0; i < lines.length; i++) {
      (function (line) {
        var box = line.ownerSVGElement.getBoundingClientRect();
        var nums = (line.getAttribute("d").match(/-?\\d+(\\.\\d+)?/g) || []).map(Number);
        var total = 0;
        for (var k = 2; k + 1 < nums.length; k += 2) {
          var dx = ((nums[k] - nums[k - 2]) * box.width) / 100;
          var dy = ((nums[k + 1] - nums[k - 1]) * box.height) / 100;
          total += Math.sqrt(dx * dx + dy * dy);
        }
        line.style.setProperty("--len", String(Math.ceil(total) + 2));
        line.addEventListener("animationend", function () { line.classList.add("done"); });
      })(lines[i]);
    }
  }
  function enter(sec) {
    if (sec.classList.contains("in")) return;
    lineLengths(sec);
    sec.classList.add("in");
    var nums = sec.querySelectorAll("[data-n]");
    for (var i = 0; i < nums.length; i++) countUp(nums[i], 200);
  }
  function hover(chart) {
    var data;
    try { data = JSON.parse(chart.getAttribute("data-chart")).p; } catch (err) { return; }
    var plot = chart.querySelector(".plot");
    if (!plot || !data.length) return;
    var cross = el("span", "cross");
    var tip = el("div", "tip");
    tip.setAttribute("role", "status");
    plot.appendChild(cross);
    plot.appendChild(tip);
    var slots = plot.querySelectorAll(".slot[data-i]");
    var at = -1;
    function mark(i) {
      for (var k = 0; k < slots.length; k++) {
        slots[k].classList.toggle("on", Number(slots[k].getAttribute("data-i")) === i);
      }
    }
    function open(i) {
      i = Math.max(0, Math.min(data.length - 1, i));
      if (i !== at) {
        at = i;
        var p = data[i];
        tip.textContent = "";
        tip.appendChild(el("div", "tt", p.t));
        for (var k = 0; k < p.l.length; k++) {
          var row = el("div", "tr");
          row.appendChild(el("span", "", p.l[k][0]));
          row.appendChild(el("span", "", p.l[k][1]));
          tip.appendChild(row);
        }
        mark(i);
      }
      var point = data[at];
      var w = plot.clientWidth;
      var h = plot.clientHeight;
      var x = (point.x * w) / 100;
      var y = (point.y * h) / 100;
      var left = Math.max(0, Math.min(w - tip.offsetWidth, x - tip.offsetWidth / 2));
      var top = y - tip.offsetHeight - 12;
      if (top < -tip.offsetHeight - 6) top = y + 12;
      tip.style.transform = "translate(" + Math.round(left) + "px," + Math.round(top) + "px)";
      cross.style.left = x + "px";
      if (!slots.length) cross.classList.add("on");
      tip.classList.add("on");
    }
    function close() {
      at = -1;
      mark(-1);
      cross.classList.remove("on");
      tip.classList.remove("on");
    }
    function nearest(clientX) {
      var box = plot.getBoundingClientRect();
      var fx = ((clientX - box.left) / box.width) * 100;
      var best = 0;
      for (var k = 1; k < data.length; k++) {
        if (Math.abs(data[k].x - fx) < Math.abs(data[best].x - fx)) best = k;
      }
      return best;
    }
    plot.addEventListener("pointermove", function (ev) { open(nearest(ev.clientX)); });
    plot.addEventListener("pointerdown", function (ev) { open(nearest(ev.clientX)); });
    plot.addEventListener("pointerleave", function () { if (document.activeElement !== plot) close(); });
    plot.addEventListener("focus", function () { open(at < 0 ? data.length - 1 : at); });
    plot.addEventListener("blur", close);
    plot.addEventListener("keydown", function (ev) {
      if (ev.key === "ArrowLeft") open((at < 0 ? data.length : at) - 1);
      else if (ev.key === "ArrowRight") open(at + 1);
      else if (ev.key === "Home") open(0);
      else if (ev.key === "End") open(data.length - 1);
      else if (ev.key === "Escape") close();
      else return;
      ev.preventDefault();
    });
  }
  try {
    var charts = document.querySelectorAll("[data-chart]");
    for (var c = 0; c < charts.length; c++) hover(charts[c]);
    if (!moving) return;
    var heads = document.querySelectorAll(".figs [data-n]");
    for (var f = 0; f < heads.length; f++) countUp(heads[f], f * 70);
    var secs = document.querySelectorAll(".sec");
    if (!("IntersectionObserver" in window)) {
      for (var s = 0; s < secs.length; s++) enter(secs[s]);
      return;
    }
    var seen = new IntersectionObserver(function (entries) {
      for (var e = 0; e < entries.length; e++) {
        if (entries[e].isIntersecting) {
          enter(entries[e].target);
          seen.unobserve(entries[e].target);
        }
      }
    }, { threshold: 0.2 });
    for (var o = 0; o < secs.length; o++) seen.observe(secs[o]);
  } catch (err) {
    root.classList.remove("js-motion");
  }
})();
</script>`;
}

function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

function signed(value: number, format: "usd" | "int"): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  const abs = Math.abs(value);
  return `${sign}${format === "usd" ? fmtUsd(abs) : fmtInt(abs)}`;
}

/** "+9 in 7 days", "no change in 7 days", "−$4.10 since 21 Sep". Direction is carried by the sign, not by color. */
export function changeLine(change: Change | null, format: "usd" | "int"): string {
  if (!change) return "";
  const span = change.exact ? "in 7 days" : `since ${shortDay(change.since)}`;
  if (change.delta.dir === "flat") return `No change ${span}`;
  const pct =
    format === "int" || change.delta.pct === null || Math.abs(change.delta.pct) < 1
      ? ""
      : ` (${change.delta.pct > 0 ? "+" : "−"}${Math.abs(change.delta.pct).toFixed(0)}%)`;
  return `${signed(change.delta.abs, format)}${pct} ${span}`;
}

function count(value: number, format: "usd" | "int" | "dec1" = "int"): string {
  const text = format === "usd" ? fmtUsd(value) : format === "dec1" ? value.toFixed(1) : fmtInt(value);
  return `<span data-n="${value}" data-f="${format}">${esc(text)}</span>`;
}

function figure(opts: { col: number; lead?: boolean; label: string; value: string; lines: string[] }): string {
  const lines = opts.lines.filter(Boolean).map((line) => `<span>${esc(line)}</span>`).join("");
  return `<div class="fig${opts.lead ? " lead" : ""}" style="--c:${opts.col};--m:${opts.col - 1}">
    <dt>${esc(opts.label)}</dt>
    <dd class="fig-n">${opts.value}</dd>
    <dd class="fig-s">${lines}</dd>
  </div>`;
}

function figures(o: Overview): string {
  const since = o.firstSignup ? `Since ${shortDay(o.firstSignup)}` : "";
  const money = o.chainOk || o.value.length > 0;
  const avg = o.dauAvg
    ? `${o.dauAvg.days >= 7 ? "7-day" : `${o.dauAvg.days}-day`} average ${o.dauAvg.avg.toFixed(1)}`
    : "Not recorded yet";
  return `<dl class="figs" aria-label="Headline figures">
    ${figure({
      col: 1,
      lead: true,
      label: "Value held",
      value: money ? count(o.tvl, "usd") : "—",
      lines: money
        ? [`${fmtUsd(o.lp)} in positions · ${fmtUsd(o.idle)} idle USDC`, changeLine(o.changes.tvl, "usd") || "History starts today"]
        : ["Not available right now"],
    })}
    ${figure({ col: 2, label: "Users", value: count(o.users), lines: [changeLine(o.changes.users, "int") || since] })}
    ${figure({ col: 3, label: "Accounts", value: count(o.accounts), lines: [changeLine(o.changes.accounts, "int") || since] })}
    ${figure({
      col: 4,
      label: "Activated",
      value: count(o.activated),
      lines: ["With a position", changeLine(o.changes.activated, "int")],
    })}
    ${figure({
      col: 5,
      label: "Active today",
      value: o.dauToday === null ? "—" : count(o.dauToday),
      lines: [avg],
    })}
    ${figure({
      col: 6,
      label: "In range",
      value: `${count(o.positionsInRange)}<span class="of">of ${fmtInt(o.positions)}</span>`,
      lines: [o.positions === 1 ? "Position" : "Positions"],
    })}
  </dl>`;
}

function table(summary: string, head: string[], rows: string[][]): string {
  if (!rows.length) return "";
  const th = head.map((h) => `<th>${esc(h)}</th>`).join("");
  const body = rows.map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join("")}</tr>`).join("");
  return `<details class="tbl"><summary>${esc(summary)}</summary><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></details>`;
}

function valueSection(o: Overview): string {
  const chart = renderTimeChart({
    id: "value",
    title: "Value held over the last 30 days, split into idle USDC and positions",
    days: o.value.map((p) => p.day),
    series: [
      { label: "Idle USDC", tone: "stone", values: o.value.map((p) => p.idle) },
      { label: "In positions", tone: "emerald", values: o.value.map((p) => p.lp) },
    ],
    stacked: true,
    totalLabel: "Value held",
    format: "usd",
    emptyNote: "Nothing captured yet. The first daily snapshot starts the line.",
    singleNote: "History starts today. One capture a day draws the line from here.",
  });
  return `<section class="sec" style="--s:0ms">
    <div class="sec-head">
      <h2>Value held, last 30 days</h2>
      <ul class="legend">
        <li><span class="key sw sw-emerald"></span>In positions<b>${esc(fmtUsd(o.lp))}</b></li>
        <li><span class="key sw sw-stone"></span>Idle USDC<b>${esc(fmtUsd(o.idle))}</b></li>
      </ul>
    </div>
    ${chart}
    ${table(
      "Figures",
      ["Day", "Value held", "In positions", "Idle USDC"],
      o.value.map((p) => [shortDay(p.day), fmtUsd(p.idle + p.lp), fmtUsd(p.lp), fmtUsd(p.idle)]),
    )}
  </section>`;
}

function growthSection(o: Overview): string {
  const chart = renderTimeChart({
    id: "growth",
    title: "Users and accounts, running total since the first signup",
    days: o.growth.map((p) => p.day),
    series: [
      { label: "Users", tone: "ink", values: o.growth.map((p) => p.users) },
      { label: "Accounts", tone: "emerald", values: o.growth.map((p) => p.accounts), dashed: true },
    ],
    format: "int",
    emptyNote: "Nobody has signed up yet.",
    singleNote: "The first signups arrived today.",
  });
  const since = o.firstSignup ? `, since ${shortDay(o.firstSignup)}` : "";
  return `<section class="sec" style="--s:0ms">
    <div class="sec-head">
      <h2>Users and accounts${esc(since)}</h2>
      <ul class="legend">
        <li><span class="key"></span>Users<b>${fmtInt(o.users)}</b></li>
        <li><span class="key k-emerald dashed"></span>Accounts<b>${fmtInt(o.accounts)}</b></li>
      </ul>
    </div>
    ${chart}
    ${table(
      "Figures",
      ["Day", "Users", "Accounts"],
      o.growth.slice(-30).map((p) => [shortDay(p.day), fmtInt(p.users), fmtInt(p.accounts)]),
    )}
  </section>`;
}

function dauSection(o: Overview): string {
  const slots = o.dau ?? dauSlots(new Map(), null, o.today, DAU_DAYS);
  const tracked = slots.filter((s) => s.n !== null);
  const note = o.dau === null ? "Activity is not being recorded yet." : "No activity recorded yet.";
  const chart = renderBars({
    id: "dau",
    title: "Accounts active per day, last 14 days",
    slots,
    emptyNote: note,
  });
  const aside =
    tracked.length > 0 && tracked.length < slots.length
      ? `<p class="soft cap">Recorded since ${esc(shortDay(tracked[0].day))}.</p>`
      : "";
  return `<section class="sec" style="--s:120ms">
    <div class="sec-head"><h2>Active accounts, last 14 days</h2></div>
    ${chart}
    ${aside}
    ${table("Figures", ["Day", "Active"], tracked.map((s) => [shortDay(s.day), fmtInt(s.n ?? 0)]))}
  </section>`;
}

function funnelSection(o: Overview): string {
  return `<section class="sec" style="--s:120ms">
    <div class="sec-head"><h2>From signup to in range</h2></div>
    ${renderFunnel(o.funnel)}
  </section>`;
}

const STATUS_COPY = { ok: "OK", low: "Low", empty: "Empty" } as const;

function runwaySection(o: Overview): string {
  const link = `<a href="/ops/infra">Infra and costs</a>`;
  if (!o.relayer) {
    return `<section class="sec full" style="--s:0ms">
      <div class="sec-head"><h2>Relayer runway</h2>${link}</div>
      <p class="soft" style="margin-top:1rem">Base is unreachable right now, so the relayer balance is not shown.</p>
    </section>`;
  }
  const r = o.relayer;
  const eth = `${r.ethBalance.toFixed(r.ethBalance < 0.001 ? 6 : 4)} ETH`;
  const usd = r.usd === null ? "" : ` · ${fmtUsd(r.usd)}`;
  const can = r.canFund ?? 0;
  const lead =
    r.canFund === null
      ? `<p class="run-n soft">Cost per account is not available.</p>`
      : `<p class="run-n"><span class="fig-n">${count(can)}</span><span class="soft">more ${can === 1 ? "account" : "accounts"} it can fund</span></p>`;
  return `<section class="sec full" style="--s:0ms">
    <div class="sec-head"><h2>Relayer runway</h2>${link}</div>
    <div class="runway">
      ${lead}
      ${renderTally(can) || "<span></span>"}
      <p class="run-s">${esc(eth)}${esc(usd)}<br /><span class="status-${r.status}">Status: ${STATUS_COPY[r.status]}</span></p>
    </div>
  </section>`;
}

export function renderOverview(opts: { overview: Overview; csrf: string; nonce: string; who?: string }): string {
  const o = opts.overview;
  const csrf = `<input type="hidden" name="csrf" value="${esc(opts.csrf)}" />`;
  const notes = o.notes.length
    ? `<div class="notes soft">${o.notes.map((note) => `<p>${esc(note)}</p>`).join("")}</div>`
    : "";
  const who = opts.who ? `<span class="soft">Signed in as ${esc(opts.who)} · </span>` : "";
  return opsShell(
    "Overview",
    `<header class="ov-head">
      <h1>Overview</h1>
      <form class="asof" method="post" action="/ops/metrics/snapshot">
        ${csrf}
        As of <time datetime="${esc(o.asOf)}">${esc(when(o.asOf))}</time>
        <button class="link" type="submit">Refresh</button>
      </form>
    </header>
    ${notes}
    ${figures(o)}
    <div class="cols">
      ${valueSection(o)}
      ${funnelSection(o)}
      ${growthSection(o)}
      ${dauSection(o)}
      ${runwaySection(o)}
    </div>
    <footer class="ov-foot">
      <p><a href="/ops/landing">The site</a></p>
      <form method="post" action="/ops/logout">
        ${csrf}
        ${who}<button class="quiet" type="submit">Sign out</button>
      </form>
    </footer>
    ${bodyScript(opts.nonce)}`,
    renderNav("overview"),
    { wide: true, head: `<style>${STYLE}</style>${headScript(opts.nonce)}` },
  );
}
