/**
 * The one script of the /ops console, shipped with every full document under the
 * page's CSP nonce. It holds the router (instant navigation between sections) and
 * every section module, so swapping a section never needs a new script tag.
 *
 * Section contract: `modules[id](root, quiet)` mounts a section into `root` and
 * returns a teardown function the router calls before the next swap.
 * Pure decisions live in opsRouterLogic() and topupLogic(), embedded here from
 * source so the tests exercise the code that ships.
 */

import { opsRouterLogic } from "./ops-router-logic";
import { topupLogic } from "./topup-logic";

/** Runs before first paint so nothing flashes in its final state and then restarts. */
export function motionHeadScript(nonce: string): string {
  return `<script nonce="${nonce}">if(!window.matchMedia||!matchMedia("(prefers-reduced-motion: reduce)").matches)document.documentElement.classList.add("js-motion");</script>`;
}

export function opsClientScript(nonce: string): string {
  return `<script nonce="${nonce}">
(function () {
  var __name = function (fn) { return fn; };
  var R = (/*router-logic*/${opsRouterLogic.toString()}/*end-router-logic*/)();
  var L = (/*topup-logic*/${topupLogic.toString()}/*end-topup-logic*/)();
  var root = document.documentElement;
  var main = document.getElementById("ops-main");
  var live = document.getElementById("ops-live");
  var bar = document.getElementById("ops-progress");
  if (!main) return;
  var moving = root.classList.contains("js-motion");
  var SUFFIX = " \\u00b7 Mamoru ops";

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /* ---------- motion and charts, shared by the sections ---------- */

  function usd(v) {
    if (v >= 1e6) return "$" + (v / 1e6).toFixed(1) + "M";
    if (v >= 1e4) return "$" + (v / 1e3).toFixed(1) + "K";
    if (v >= 1e3) return "$" + Math.round(v).toLocaleString("en-US");
    return "$" + v.toFixed(2);
  }
  function show(kind, v) {
    if (kind === "usd") return usd(v);
    if (kind.slice(0, 3) === "dec") return v.toFixed(Number(kind.slice(3)));
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
      if (!node.isConnected) return;
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
  /** Mounts charts and entrance motion. Quiet = final state at once (revisits, in-place updates, reduced motion). */
  function mountMotion(scope, quiet) {
    var charts = scope.querySelectorAll("[data-chart]");
    for (var c = 0; c < charts.length; c++) hover(charts[c]);
    var secs = scope.querySelectorAll(".sec");
    if (!moving || quiet) {
      scope.classList.add("still");
      for (var q = 0; q < secs.length; q++) secs[q].classList.add("in");
      var drawn = scope.querySelectorAll(".layer.ink .line");
      for (var d = 0; d < drawn.length; d++) drawn[d].classList.add("done");
      return function () {};
    }
    scope.classList.remove("still");
    var heads = scope.querySelectorAll(".figs [data-n]");
    for (var f = 0; f < heads.length; f++) countUp(heads[f], f * 70);
    if (!("IntersectionObserver" in window)) {
      for (var s = 0; s < secs.length; s++) enter(secs[s]);
      return function () {};
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
    return function () { seen.disconnect(); };
  }

  /* ---------- the relayer top-up widget ---------- */

  // State lives here, outside the section, so a connected wallet survives section changes.
  var Topup = (function () {
    var state = { phase: "idle", account: null, balance: null, fee: null, amountText: "", hash: null, error: "", slow: false, failedTo: "idle" };
    var ctx = { relayer: "", costWei: null, ethUsd: null };
    var cfg = null, dom = null, eth = null, bound = null, run = 0, pollTimer = null, refreshed = false;

    function paint() {
      if (!dom) return;
      var v = L.view(state, ctx);
      dom.line.textContent = v.line;
      dom.line.className = "tu-line" + (v.tone === "plain" ? "" : " " + v.tone);
      dom.detail.textContent = v.detail;
      dom.walletRow.hidden = !v.wallet;
      dom.walletText.textContent = v.wallet;
      dom.hint.textContent = v.hint;
      dom.input.readOnly = v.amountLocked;
      var steps = dom.root.querySelectorAll(".tu-steps li");
      for (var i = 0; i < steps.length; i++) {
        if (Number(steps[i].getAttribute("data-step")) === v.step) steps[i].setAttribute("aria-current", "step");
        else steps[i].removeAttribute("aria-current");
      }
      var parsed = L.parseEth(state.amountText);
      var presets = dom.root.querySelectorAll(".tu-preset[data-amt]");
      for (var p = 0; p < presets.length; p++) {
        var preset = L.parseEth(presets[p].getAttribute("data-amt"));
        presets[p].setAttribute("aria-pressed", String(Boolean(parsed.ok && preset.ok && parsed.wei === preset.wei)));
        presets[p].disabled = v.amountLocked;
      }
      var most = state.balance !== null && state.fee !== null ? L.maxSend(state.balance, state.fee) : null;
      dom.max.disabled = v.amountLocked || most === null || !(most > BigInt(0));
      dom.max.setAttribute("aria-pressed", String(Boolean(most !== null && parsed.ok && parsed.wei === most)));
      button(dom.primary, v.primary);
      button(dom.secondary, v.secondary);
      dom.offer.hidden = !v.offer;
      if (v.offer) { dom.offer.textContent = v.offer.label; dom.offer.setAttribute("data-amt", v.offer.amountText); }
      dom.link.hidden = !v.link;
      if (v.link) { dom.link.href = v.link.href; dom.link.textContent = v.link.text; }
      // A wallet step in progress must not be repainted from under the reader.
      var busy = state.phase === "confirm" || state.phase === "signing" || state.phase === "connecting";
      if (busy) main.setAttribute("data-busy", "1");
      else main.removeAttribute("data-busy");
    }
    function button(node, action) {
      node.hidden = !action;
      if (!action) return;
      node.textContent = action.label;
      node.disabled = !action.enabled;
      node.setAttribute("data-act", action.action);
    }
    function set(patch) {
      for (var key in patch) state[key] = patch[key];
      paint();
    }
    function fail(err, backTo) {
      stopPolling();
      set({ phase: "failed", error: L.explain(err), failedTo: backTo });
    }
    function request(method, params) {
      return eth.request({ method: method, params: params || [] });
    }
    function setAmount(text) {
      if (dom) dom.input.value = text;
      state.amountText = text;
      if (state.phase === "failed" && state.account) state.phase = "ready";
      paint();
    }
    function bind(provider) {
      if (bound === provider) return;
      bound = provider;
      if (!provider.on) return;
      provider.on("accountsChanged", function (accounts) {
        if (state.phase === "sent" || state.phase === "confirmed") return;
        if (!accounts || !accounts.length) { reset(); return; }
        state.account = accounts[0];
        afterAccount();
      });
      provider.on("chainChanged", function () {
        if (!state.account || state.phase === "sent" || state.phase === "confirmed") return;
        afterAccount();
      });
    }
    function detect() {
      eth = window.ethereum || null;
      if (!eth) { set({ phase: "nowallet" }); return; }
      bind(eth);
      var mine = ++run;
      set({ phase: "idle" });
      // Already approved for this site: pick the wallet up without a prompt.
      request("eth_accounts").then(function (accounts) {
        if (mine !== run || !accounts || !accounts.length) return;
        state.account = accounts[0];
        afterAccount();
      }).catch(function () {});
    }
    function reset() {
      stopPolling();
      run++;
      refreshed = false;
      set({ phase: eth ? "idle" : "nowallet", account: null, balance: null, fee: null, hash: null, error: "", slow: false });
    }
    function connect() {
      if (!eth) { detect(); if (!eth) return; }
      var mine = ++run;
      set({ phase: "connecting", error: "" });
      request("eth_requestAccounts").then(function (accounts) {
        if (mine !== run) return;
        if (!accounts || !accounts.length) { fail({ code: 4100 }, "idle"); return; }
        state.account = accounts[0];
        afterAccount();
      }).catch(function (err) { if (mine === run) fail(err, "idle"); });
    }
    function change() {
      var mine = ++run;
      stopPolling();
      request("wallet_requestPermissions", [{ eth_accounts: {} }]).then(function () {
        return request("eth_accounts");
      }).then(function (accounts) {
        if (mine !== run) return;
        if (!accounts || !accounts.length) { reset(); return; }
        state.account = accounts[0];
        afterAccount();
      }).catch(function (err) {
        if (mine !== run) return;
        // Declining the picker just keeps the current wallet.
        if (Number(err && err.code) === 4001) { paint(); return; }
        reset();
      });
    }
    function afterAccount() {
      var mine = ++run;
      refreshed = false;
      set({ phase: "ready", balance: null, fee: null, hash: null, error: "", slow: false });
      request("eth_chainId").then(function (chainId) {
        if (mine !== run) return;
        if (String(chainId).toLowerCase() !== L.BASE_CHAIN_HEX) { set({ phase: "wrongnet" }); return; }
        readBalance(mine);
      }).catch(function (err) { if (mine === run) fail(err, "idle"); });
    }
    function readBalance(mine, then) {
      Promise.all([request("eth_getBalance", [state.account, "latest"]), request("eth_gasPrice")]).then(function (res) {
        if (mine !== run) return;
        var balance = L.fromHex(res[0]), gasPrice = L.fromHex(res[1]);
        if (balance === null || gasPrice === null) { fail({ message: "the wallet did not return a balance" }, "ready"); return; }
        set({ balance: balance, fee: L.estimateFee(gasPrice) });
        if (then) then();
      }).catch(function (err) { if (mine === run) fail(err, "ready"); });
    }
    function switchChain() {
      var mine = ++run;
      request("wallet_switchEthereumChain", [{ chainId: L.BASE_CHAIN_HEX }]).catch(function (err) {
        if (Number(err && err.code) !== 4902) throw err;
        return request("wallet_addEthereumChain", [{
          chainId: L.BASE_CHAIN_HEX,
          chainName: "Base",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: [cfg.addChainRpc],
          blockExplorerUrls: ["https://basescan.org"],
        }]);
      }).then(function () { if (mine === run) afterAccount(); })
        .catch(function (err) { if (mine === run) fail(err, "wrongnet"); });
    }
    // Preflight: read the balance and gas price again, and only move on when the amount is affordable.
    function review() {
      var mine = ++run;
      readBalance(mine, function () {
        var parsed = L.parseEth(state.amountText);
        if (!parsed.ok || !L.afford(state.balance, parsed.wei, state.fee).ok) { paint(); return; }
        set({ phase: "confirm" });
      });
    }
    function send() {
      var parsed = L.parseEth(state.amountText);
      if (!parsed.ok || state.balance === null || state.fee === null || !L.afford(state.balance, parsed.wei, state.fee).ok) {
        set({ phase: "ready" });
        return;
      }
      var mine = ++run;
      set({ phase: "signing" });
      request("eth_sendTransaction", [{ from: state.account, to: cfg.relayer, value: L.toHex(parsed.wei) }]).then(function (hash) {
        if (mine !== run) return;
        set({ phase: "sent", hash: String(hash), slow: false });
        poll(mine, 0);
      }).catch(function (err) { if (mine === run) fail(err, "ready"); });
    }
    function stopPolling() {
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
    }
    function poll(mine, tries) {
      stopPolling();
      request("eth_getTransactionReceipt", [state.hash]).then(function (receipt) {
        if (mine !== run) return;
        if (receipt && receipt.status) {
          if (Number(receipt.status) === 1) {
            set({ phase: "confirmed" });
            pollTimer = setTimeout(reload, 1800);
          } else {
            fail({ message: "the transaction was included but reverted, so nothing reached the relayer" }, "ready");
          }
          return;
        }
        again(mine, tries);
      }).catch(function () { if (mine === run) again(mine, tries); });
    }
    function again(mine, tries) {
      if (tries >= 30) { set({ slow: true }); return; }
      pollTimer = setTimeout(function () { poll(mine, tries + 1); }, 2500);
    }
    // After a confirmed transfer the figures are read again, once, in place.
    function reload() {
      if (refreshed) return;
      refreshed = true;
      Shell.refresh("/ops/infra?fresh=1");
    }
    var actions = {
      detect: detect,
      connect: connect,
      change: change,
      "switch": switchChain,
      review: review,
      send: send,
      reload: function () { refreshed = false; reload(); },
      reset: reset,
      back: function () { run++; set({ phase: "ready" }); },
      restart: function () { stopPolling(); state.hash = null; afterAccount(); },
      check: function () { set({ slow: false }); poll(++run, 0); },
      retry: function () {
        if (!state.account) { reset(); return; }
        afterAccount();
      },
      max: function () {
        if (state.balance === null || state.fee === null) return;
        setAmount(L.formatEth(L.maxSend(state.balance, state.fee)));
      },
    };
    function copy(node) {
      var done = function () {
        node.textContent = "Copied";
        setTimeout(function () { node.textContent = "Copy"; }, 2000);
      };
      var select = function () {
        var range = document.createRange();
        range.selectNodeContents(dom.addr);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        node.textContent = "Selected, now copy";
      };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(cfg.relayer).then(done, select);
      else select();
    }

    function init(scope) {
      var box = scope.querySelector("#topup");
      if (!box || typeof BigInt !== "function") return function () {};
      try { cfg = JSON.parse(box.getAttribute("data-topup")); } catch (err) { return function () {}; }
      ctx = { relayer: cfg.relayer, costWei: cfg.costWei ? BigInt(cfg.costWei) : null, ethUsd: cfg.ethUsd };
      var $ = function (id) { return box.querySelector("#" + id); };
      dom = {
        root: box, line: $("tu-line"), detail: $("tu-detail"), walletRow: $("tu-wallet"), walletText: $("tu-wallet-text"),
        input: $("tu-input"), hint: $("tu-hint"), max: $("tu-max"), primary: $("tu-primary"), secondary: $("tu-secondary"),
        offer: $("tu-offer"), link: $("tu-link"), addr: $("tu-addr"),
      };
      dom.input.value = state.amountText;
      box.addEventListener("click", function (ev) {
        var node = ev.target && ev.target.closest ? ev.target.closest("button") : null;
        if (!node || node.disabled || !box.contains(node)) return;
        if (node.id === "tu-copy") { copy(node); return; }
        var amt = node.getAttribute("data-amt");
        if (amt) { setAmount(amt); return; }
        var act = actions[node.getAttribute("data-act")];
        if (act) act();
      });
      dom.input.addEventListener("input", function () {
        state.amountText = dom.input.value;
        if (state.phase === "failed" && state.account) state.phase = "ready";
        paint();
      });
      dom.input.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" && !dom.primary.hidden && !dom.primary.disabled) dom.primary.click();
      });
      var timers = [];
      if (state.account && eth) {
        // Coming back to the section: the wallet is still connected, show it as it was.
        paint();
        if (state.phase === "sent" && !state.slow) poll(++run, 0);
      } else {
        detect();
        // Wallets on phones can inject late: look again shortly, and when they announce themselves.
        if (!eth) {
          window.addEventListener("ethereum#initialized", function () { if (!eth && dom) detect(); }, { once: true });
          timers.push(setTimeout(function () { if (!eth && dom) detect(); }, 1200));
          timers.push(setTimeout(function () { if (!eth && dom) detect(); }, 3500));
        }
      }
      return function () {
        for (var t = 0; t < timers.length; t++) clearTimeout(timers[t]);
        stopPolling();
        dom = null;
        main.removeAttribute("data-busy");
      };
    }
    return { init: init };
  })();

  var modules = {
    overview: function (scope, quiet) { return mountMotion(scope, quiet); },
    mails: function (scope, quiet) { return mountMotion(scope, quiet); },
    experiments: function (scope, quiet) { return mountMotion(scope, quiet); },
    infra: function (scope, quiet) {
      var offMotion = mountMotion(scope, quiet);
      var offTopup = Topup.init(scope);
      return function () { offMotion(); offTopup(); };
    },
  };

  /* ---------- the router ---------- */

  var cache = {};
  var inflight = {};
  var visited = {};
  var teardown = null;
  var navToken = 0;
  var refreshTimer = null;
  var here = function () { return R.routeKey(window.location.href, window.location.origin); };

  var progress = (function () {
    var timer = null;
    return {
      start: function () {
        if (!bar) return;
        clearTimeout(timer);
        bar.className = "";
        timer = setTimeout(function () { bar.className = "on"; }, R.PROGRESS_AFTER_MS);
      },
      done: function () {
        if (!bar) return;
        clearTimeout(timer);
        if (bar.className === "on") {
          bar.className = "on done";
          timer = setTimeout(function () { bar.className = ""; }, 260);
        } else {
          bar.className = "";
        }
      },
    };
  })();

  function remember(key, view) {
    cache[key] = { at: Date.now(), view: view };
    var drop = R.evict(cache);
    for (var i = 0; i < drop.length; i++) delete cache[drop[i]];
  }
  function read(res) {
    var kind = R.classify({
      status: res.status,
      type: res.headers.get("content-type") || "",
      auth: res.headers.get("x-ops-auth") || "",
      redirected: res.redirected,
      opaque: res.type === "opaqueredirect",
    });
    if (kind !== "render") return Promise.resolve({ kind: kind });
    return res.json().then(function (body) {
      return R.isView(body) ? { kind: "render", view: body } : { kind: "full" };
    });
  }
  /** One fragment request per section at a time; hover, focus and click share it. */
  function load(url) {
    var key = R.routeKey(url, window.location.origin);
    var fresh = R.wantsFresh(url, window.location.origin);
    var slot = key + (fresh ? "?fresh" : "");
    if (inflight[slot]) return inflight[slot];
    var job = fetch(url, {
      headers: { "x-ops-fragment": "1", accept: "application/json" },
      credentials: "same-origin",
      redirect: "manual",
      cache: "no-store",
    }).then(read).then(function (result) {
      delete inflight[slot];
      if (result.kind === "render" && R.sectionOf(key) === result.view.section) remember(key, result.view);
      return result;
    }, function (err) {
      delete inflight[slot];
      throw err;
    });
    inflight[slot] = job;
    return job;
  }
  function markNav(section) {
    var links = document.querySelectorAll(".ops-nav a[data-section]");
    for (var i = 0; i < links.length; i++) {
      if (links[i].getAttribute("data-section") === section) links[i].setAttribute("aria-current", "page");
      else links[i].removeAttribute("aria-current");
    }
  }
  function mount(view, quiet) {
    if (teardown) {
      try { teardown(); } catch (err) {}
      teardown = null;
    }
    main.innerHTML = view.html;
    main.setAttribute("data-section", view.section);
    document.title = view.title + SUFFIX;
    markNav(view.section);
    var still = quiet || Boolean(visited[view.section]);
    visited[view.section] = true;
    var module = modules[view.section];
    teardown = module ? module(main, still) : null;
    watchRefresh(view);
  }
  function announce(text) {
    if (!live) return;
    live.textContent = "";
    setTimeout(function () { live.textContent = text; }, 30);
  }
  /** Paints a section. A navigation moves scroll and focus; an in-place update leaves both alone. */
  function paint(view, opts) {
    var after = function () {
      if (opts.inPlace) return;
      window.scrollTo(0, opts.y || 0);
      var heading = main.querySelector("h1");
      if (heading) {
        heading.setAttribute("tabindex", "-1");
        heading.focus({ preventScroll: true });
      }
      announce(view.title);
    };
    if (!opts.inPlace && moving && document.startViewTransition) {
      var transition = document.startViewTransition(function () { mount(view, false); });
      transition.updateCallbackDone.then(after, after);
    } else {
      mount(view, Boolean(opts.inPlace));
      after();
    }
  }
  /** The server is recomputing in the background: look again shortly, a few times at most. */
  function watchRefresh(view) {
    clearTimeout(refreshTimer);
    if (!view.refreshing) return;
    var key = here();
    var tries = 0;
    var tick = function () {
      if (here() !== key || tries >= 4) return;
      tries++;
      revalidate(key, function (next) {
        if (next && next.refreshing) refreshTimer = setTimeout(tick, 3000);
      });
    };
    refreshTimer = setTimeout(tick, 2500);
  }
  function typing() {
    var active = document.activeElement;
    return Boolean(active && main.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
  }
  function tickNote() {
    var asof = main.querySelector(".asof");
    if (!asof) return;
    var note = el("span", "tick-note", "Updated just now");
    asof.appendChild(note);
    setTimeout(function () { if (note.parentNode) note.parentNode.removeChild(note); }, 4000);
  }
  /** Fetches a section again and, if it changed and the reader is still there, updates it in place. */
  function revalidate(url, then) {
    var key = R.routeKey(url, window.location.origin);
    var before = cache[key] ? cache[key].view.html : null;
    load(url).then(function (result) {
      if (result.kind !== "render") { if (then) then(null); return; }
      var changed = before !== result.view.html;
      if (changed && here() === key && !typing() && !main.hasAttribute("data-busy")) {
        paint(result.view, { inPlace: true });
        tickNote();
      }
      if (then) then(result.view);
    }).catch(function () { if (then) then(null); });
  }
  function leave(url) {
    window.location.assign(url);
  }
  function navigate(url, mode, y) {
    var key = R.routeKey(url, window.location.origin);
    if (!key) { leave(url); return; }
    var token = ++navToken;
    var commit = function (view) {
      if (mode === "push") {
        history.replaceState({ ops: 1, y: window.scrollY }, "");
        history.pushState({ ops: 1, y: 0 }, "", url);
      }
      paint(view, { y: mode === "pop" ? y : 0 });
    };
    var fresh = R.wantsFresh(url, window.location.origin);
    var state = fresh ? "miss" : R.cacheState(cache[key], Date.now());
    if (state !== "miss") {
      commit(cache[key].view);
      if (state === "stale") revalidate(url);
      return;
    }
    progress.start();
    load(url).then(function (result) {
      if (token !== navToken) return;
      progress.done();
      if (result.kind !== "render") { leave(url); return; }
      commit(result.view);
    }).catch(function () {
      if (token !== navToken) return;
      progress.done();
      leave(url);
    });
  }
  function linkOf(ev) {
    var node = ev.target && ev.target.closest ? ev.target.closest("a[href]") : null;
    if (!node) return null;
    return {
      href: node.href,
      origin: window.location.origin,
      current: window.location.pathname + window.location.search,
      target: node.getAttribute("target") || "",
      download: node.hasAttribute("download"),
      full: node.hasAttribute("data-ops-full"),
    };
  }
  var PLAIN = { button: 0, meta: false, ctrl: false, shift: false, alt: false, prevented: false };

  document.addEventListener("click", function (ev) {
    var link = linkOf(ev);
    if (!link) return;
    var click = { button: ev.button, meta: ev.metaKey, ctrl: ev.ctrlKey, shift: ev.shiftKey, alt: ev.altKey, prevented: ev.defaultPrevented };
    if (!R.shouldIntercept(link, click)) return;
    ev.preventDefault();
    if (R.routeKey(link.href, link.origin) === here() && !R.wantsFresh(link.href, link.origin)) {
      window.scrollTo(0, 0);
      return;
    }
    navigate(link.href, "push");
  });
  // Warm the next section as soon as the reader points at it.
  var warm = function (ev) {
    var link = linkOf(ev);
    if (!link || !R.shouldIntercept(link, PLAIN)) return;
    var key = R.routeKey(link.href, link.origin);
    if (key === here() || R.cacheState(cache[key], Date.now()) === "fresh") return;
    load(link.href).catch(function () {});
  };
  document.addEventListener("mouseover", warm);
  document.addEventListener("focusin", warm);
  document.addEventListener("touchstart", warm, { passive: true });

  window.addEventListener("popstate", function (ev) {
    if (!R.routeKey(window.location.href, window.location.origin)) { window.location.reload(); return; }
    navigate(window.location.href, "pop", ev.state && ev.state.y ? ev.state.y : 0);
  });

  // Forms post through fetch and the section updates in place. Without this script they post and redirect.
  document.addEventListener("submit", function (ev) {
    var form = ev.target;
    if (!form || !form.hasAttribute || !form.hasAttribute("data-ops-form") || form.getAttribute("data-sent")) return;
    ev.preventDefault();
    var buttons = form.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = true;
    form.setAttribute("aria-busy", "true");
    progress.start();
    var native = function () {
      form.setAttribute("data-sent", "1");
      for (var k = 0; k < buttons.length; k++) buttons[k].disabled = false;
      form.submit();
    };
    fetch(form.action, {
      method: "POST",
      headers: { "x-ops-fragment": "1", accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(new FormData(form)).toString(),
      credentials: "same-origin",
      redirect: "manual",
      cache: "no-store",
    }).then(read).then(function (result) {
      progress.done();
      // No session any more, or anything unexpected: a real navigation, which ends at the sign-in.
      if (result.kind !== "render") { leave(window.location.href); return; }
      var key = here();
      if (R.sectionOf(key) === result.view.section) remember(key, result.view);
      paint(result.view, { inPlace: true });
      var notice = main.querySelector(".notice p");
      if (notice) announce(notice.textContent);
      else tickNote();
    }).catch(function () {
      progress.done();
      native();
    });
  });

  var Shell = {
    /** Re-reads a section and updates it in place. Used after a confirmed top-up. */
    refresh: function (url) { revalidate(url); },
  };

  try {
    if ("scrollRestoration" in history) history.scrollRestoration = "manual";
    var section = main.getAttribute("data-section");
    var key = here();
    if (key && R.sectionOf(key) === section) {
      history.replaceState({ ops: 1, y: window.scrollY }, "");
      var first = { v: 1, section: section, title: document.title.replace(SUFFIX, ""), html: main.innerHTML, refreshing: main.hasAttribute("data-refreshing") };
      remember(key, first);
      watchRefresh(first);
    }
    visited[section] = true;
    var module = modules[section];
    teardown = module ? module(main, false) : null;
  } catch (err) {
    root.classList.remove("js-motion");
  }
})();
</script>`;
}
