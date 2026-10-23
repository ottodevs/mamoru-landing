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
import { labLogic } from "./lab-logic";

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
  var LAB = (/*lab-logic*/${labLogic.toString()}/*end-lab-logic*/)();
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
    var ctx = { relayer: "", costWei: null, ethUsd: null, chain: null, recipientName: "the relayer" };
    var cfg = null, dom = null, eth = null, bound = null, run = 0, pollTimer = null, refreshed = false;
    // The funding target the widget points at; kept across section changes like the wallet.
    var targetId = null, target = null;
    function transferUnderWay() { return state.phase === "confirm" || state.phase === "signing" || state.phase === "sent"; }
    function chainHex() { return target ? String(target.chain.hex).toLowerCase() : L.BASE_CHAIN_HEX; }

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
      // While a transfer is under way its target cannot change: a pending one must be seen through, or sent twice.
      var locked = transferUnderWay();
      var funds = dom.root.querySelectorAll("button[data-fund]");
      for (var f = 0; f < funds.length; f++) funds[f].disabled = locked;
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
      set({ phase: "failed", error: L.explain(err, ctx), failedTo: backTo });
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
        if (String(chainId).toLowerCase() !== chainHex()) { set({ phase: "wrongnet" }); return; }
        readBalance(mine);
      }).catch(function (err) { if (mine === run) fail(err, "idle"); });
    }
    function readBalance(mine, then) {
      Promise.all([request("eth_getBalance", [state.account, "latest"]), request("eth_gasPrice")]).then(function (res) {
        if (mine !== run) return;
        var balance = L.fromHex(res[0]), gasPrice = L.fromHex(res[1]);
        if (balance === null || gasPrice === null) { fail({ message: "the wallet did not return a balance" }, "ready"); return; }
        set({ balance: balance, fee: L.estimateFee(gasPrice, ctx.chain || undefined) });
        if (then) then();
      }).catch(function (err) { if (mine === run) fail(err, "ready"); });
    }
    function switchChain() {
      var mine = ++run;
      var c = target.chain;
      request("wallet_switchEthereumChain", [{ chainId: c.hex }]).catch(function (err) {
        if (Number(err && err.code) !== 4902 || !c.rpc) throw err;
        return request("wallet_addEthereumChain", [{
          chainId: c.hex,
          chainName: c.name,
          nativeCurrency: { name: c.symbol === "ETH" ? "Ether" : c.name, symbol: c.symbol, decimals: 18 },
          rpcUrls: [c.rpc],
          blockExplorerUrls: [c.explorerUrl],
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
      var to = target.address, want = chainHex();
      set({ phase: "signing" });
      // The network is read again right before sending, since the wallet may have switched after the review; the chain
      // id also travels in the transaction for wallets that honour it. A switch in the instant between this read and
      // the wallet handling the send cannot be closed from a page (EIP-1193), so the network is read once more after
      // signing and a mismatch is said plainly. Every target is the same relayer EOA, so such funds are not lost.
      request("eth_chainId").then(function (chainId) {
        if (mine !== run) return null;
        if (String(chainId).toLowerCase() !== want) { set({ phase: "wrongnet" }); return null; }
        return request("eth_sendTransaction", [{ from: state.account, to: to, value: L.toHex(parsed.wei), chainId: want }]);
      }).then(function (hash) {
        if (mine !== run || hash === null) return null;
        // A failed read here must never hide a hash the wallet already returned: it then counts as sent.
        return request("eth_chainId").catch(function () { return null; }).then(function (after) {
          if (mine !== run) return;
          if (after !== null && String(after).toLowerCase() !== want) {
            fail({ message: "the wallet changed network while signing, so transaction " + String(hash) + " may have gone out on chain " + String(after) + " instead of " + target.chain.name + ". It went to the same relayer address, so nothing is lost; check that chain's explorer before sending again" }, "ready");
            return;
          }
          set({ phase: "sent", hash: String(hash), slow: false });
          poll(mine, 0);
        });
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
            fail({ message: "the transaction was included but reverted, so nothing reached " + ctx.recipientName }, "ready");
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
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(target.address).then(done, select);
      else select();
    }

    /** Points the widget at one funding target: chain, asset, address, presets. A connected wallet is checked again. */
    function select(id, fromUser) {
      var list = (cfg && cfg.targets) || [];
      var next = null;
      for (var i = 0; i < list.length; i++) if (list[i].id === id) next = list[i];
      if (!next) return;
      var changed = !target || target.id !== next.id;
      target = next;
      targetId = next.id;
      var isEth = next.priceAsEth;
      ctx = {
        relayer: next.address,
        // Accounts-funded math is only meaningful for the relayer on Base.
        costWei: next.id === "relayer-base" && cfg.costWei ? BigInt(cfg.costWei) : null,
        ethUsd: isEth ? cfg.ethUsd : null,
        chain: next.chain,
        recipientName: next.recipientName,
      };
      if (!dom) return;
      dom.title.textContent = "Top up: " + next.label;
      dom.unit.textContent = next.chain.symbol;
      dom.addr.textContent = next.address;
      dom.net.textContent = "Send " + next.chain.symbol + " on the " + next.chain.name + " network only. Once it arrives, press Refresh and the balance above goes up.";
      var rows = dom.root.querySelectorAll("tr[data-target]");
      for (var r = 0; r < rows.length; r++) {
        if (rows[r].getAttribute("data-target") === next.id) rows[r].setAttribute("aria-current", "true");
        else rows[r].removeAttribute("aria-current");
      }
      var old = dom.presets.querySelectorAll(".tu-preset[data-amt]");
      for (var o = 0; o < old.length; o++) old[o].remove();
      for (var p = next.presets.length - 1; p >= 0; p--) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "tu-preset";
        b.setAttribute("data-amt", next.presets[p]);
        b.setAttribute("aria-pressed", "false");
        b.textContent = next.presets[p];
        dom.presets.insertBefore(b, dom.presets.firstChild);
      }
      if (changed && fromUser) {
        stopPolling();
        state.hash = null;
        state.amountText = "";
        dom.input.value = "";
        if (state.account && eth) { afterAccount(); return; }
      }
      paint();
    }

    function init(scope) {
      var box = scope.querySelector("#topup");
      if (!box || typeof BigInt !== "function") return function () {};
      try { cfg = JSON.parse(box.getAttribute("data-topup")); } catch (err) { return function () {}; }
      if (!cfg.targets || !cfg.targets.length) {
        // A page from before the funding list: the relayer on Base only.
        cfg.targets = [{ id: "relayer-base", label: "Relayer on Base", recipientName: "the relayer", address: cfg.relayer, presets: ["0.005", "0.01", "0.02"], priceAsEth: true,
          chain: { hex: L.BASE_CHAIN_HEX, name: "Base", symbol: "ETH", explorerTx: "https://basescan.org/tx/", explorerName: "Basescan", l1FeeMarginWei: "2000000000000", rpc: cfg.addChainRpc, explorerUrl: "https://basescan.org" } }];
      }
      var $ = function (id) { return box.querySelector("#" + id); };
      dom = {
        root: box, line: $("tu-line"), detail: $("tu-detail"), walletRow: $("tu-wallet"), walletText: $("tu-wallet-text"),
        input: $("tu-input"), hint: $("tu-hint"), max: $("tu-max"), primary: $("tu-primary"), secondary: $("tu-secondary"),
        offer: $("tu-offer"), link: $("tu-link"), addr: $("tu-addr"),
        title: $("tu-title") || document.createElement("h3"), unit: $("tu-unit") || document.createElement("span"),
        presets: $("tu-presets") || box.querySelector(".tu-presets"), net: $("tu-net") || document.createElement("p"),
      };
      select(targetId || cfg.selected || cfg.targets[0].id, false);
      dom.input.value = state.amountText;
      box.addEventListener("click", function (ev) {
        var node = ev.target && ev.target.closest ? ev.target.closest("button") : null;
        if (!node || node.disabled || !box.contains(node)) return;
        if (node.id === "tu-copy") { copy(node); return; }
        var fund = node.getAttribute("data-fund");
        if (fund) {
          if (transferUnderWay()) return;
          select(fund, true);
          dom.title.scrollIntoView({ block: "nearest" });
          return;
        }
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

  /* ---------- the Lab bench (otto/mamoru-astro#28, spec 008 phase 1) ---------- */
  // Unlike every other section, this one's data is never in the server-rendered HTML: it is fetched from the
  // screen API (B-06) at mount time, same reason the prototype's own DATA constant is gone (data comes from D1
  // now, not a build-time dump). LAB (lab-logic.ts) holds the pure math; everything here is fetch + DOM.
  var LabApp = (function () {
    var SVGNS = "http://www.w3.org/2000/svg";
    var POOLS = {
      "pool:WETH/USDC/3000": { name: "Ether", pair: "WETH/USDC 0,3 %", dp: 0 },
      "pool:USDC/cbBTC/500": { name: "Bitcoin", pair: "cbBTC/USDC 0,05 %", dp: 0 },
      "pool:USDC/USDT/100": { name: "Dólares", pair: "USDC/USDT 0,01 %", dp: 4 },
    };
    var POOL_ORDER = ["pool:WETH/USDC/3000", "pool:USDC/cbBTC/500", "pool:USDC/USDT/100"];
    var KIND = { enter_swap: "cambia tokens para entrar", enter_mint: "entra en el pool", harvest: "cobra las comisiones", rerange: "el precio salió del rango y recentra", reduce: "reduce la posición" };
    var REASON = { DECIDE_IN_RANGE: "En rango, no hace nada", DECIDE_ENTER: "Entra", DECIDE_HARVEST: "Cobra comisiones", DECIDE_RANGE_ADJUST: "Recentra", EHG_PRICE_DIVERGENCE: "Espera: precio raro frente al TWAP", DECIDE_WAIT_DEPTH: "Espera profundidad" };
    var ERROR_WORDS = {
      LAB_JOB_LEASE_LOST: "el runner perdió este trabajo",
      LAB_SPEC_INVALID: "el escenario pedido no es válido",
      LAB_DATASET_MISSING: "esta ventana no tiene datos para esa base",
      LAB_JOB_TIMEOUT: "se agotó el tiempo del trabajo",
      LAB_RUN_INVALID: "el runner devolvió un resultado con forma inválida",
      LAB_JOB_LIMIT: "se alcanzó el límite de trabajos",
      LAB_SERVICE_UNAVAILABLE: "el banco no está disponible ahora mismo",
      LAB_NETWORK: "no hubo respuesta del servidor",
    };
    var dF = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", timeZone: "UTC" });
    var tF = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

    var root = null, scope = null, csrf = "", state = null, geo = {}, playTimer = null, jobTimer = null, loadToken = 0;

    function esc(s) {
      return String(s).replace(/[&<>"']/g, function (c) {
        return c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;";
      });
    }
    function $(id) { return scope.querySelector("#" + id); }
    function el(tag, cls, text) {
      var n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text !== undefined) n.textContent = text;
      return n;
    }
    function svg(tag, attrs, parent) {
      var e = document.createElementNS(SVGNS, tag);
      for (var k in attrs) e.setAttribute(k, attrs[k]);
      if (parent) parent.appendChild(e);
      return e;
    }
    function cssVar(name) { return getComputedStyle(root).getPropertyValue(name).trim(); }
    function fp(v, pool) {
      var dp = (POOLS[pool] || {}).dp || 0;
      return new Intl.NumberFormat("es-ES", { minimumFractionDigits: dp, maximumFractionDigits: dp }).format(v);
    }
    function api(path, opts) {
      return fetch(path, Object.assign({ credentials: "same-origin", cache: "no-store" }, opts || {})).then(function (res) {
        return res
          .json()
          .catch(function () { return null; })
          .then(function (body) { return { ok: res.ok, status: res.status, body: body }; });
      });
    }

    function freshState() {
      return {
        windows: [], w: 0, selectedHash: null, pool: POOL_ORDER[0], at: 0, playing: false, speed: 1, tab: "ev", rtab: "probar",
        runFull: null, runFullHash: null, baselineFull: null, baselineHash: null,
        job: null, jobStart: 0, probe: { base: "live", width: 2000, deposit: 1000 },
      };
    }
    function windowOf() { return state.windows[state.w] || null; }
    function runsOf() { var w = windowOf(); return w ? w.runs : []; }
    function findRun(hash) {
      var runs = runsOf();
      for (var i = 0; i < runs.length; i++) if (runs[i].resultHash === hash) return runs[i];
      return null;
    }
    function selected() { return findRun(state.selectedHash) || runsOf()[0] || null; }
    function baselineKey() {
      var w = windowOf();
      return w ? LAB.specKey({ windowId: w.windowId, base: "live", widthTicks: 2000, deposit: 1000 }) : "";
    }
    function baselineSummary() {
      var key = baselineKey();
      var runs = runsOf();
      for (var i = 0; i < runs.length; i++) if (runs[i].specKey === key) return runs[i];
      return null;
    }

    /* ---------- loading ---------- */

    function loadAll() {
      var mine = ++loadToken;
      return api("/ops/lab/api/catalog").then(function (r) {
        if (mine !== loadToken) return;
        var windows = (r.body && r.body.windows) || [];
        return Promise.all(
          windows.map(function (w) {
            return api("/ops/lab/api/runs?window=" + encodeURIComponent(w.windowId)).then(function (rr) {
              return { windowId: w.windowId, label: w.label, regime: w.regime, split: w.split, from: w.from, to: w.to, bases: w.bases || [], runs: (rr.body && rr.body.runs) || [] };
            });
          }),
        ).then(function (full) {
          if (mine !== loadToken) return;
          state.windows = full;
          if (!full.length) {
            $("lab-empty").hidden = false;
            renderProbar();
            return;
          }
          var base = baselineSummary() || (full[0].runs[0] || null);
          state.selectedHash = base ? base.resultHash : null;
          renderAll();
        });
      }).catch(function () { $("lab-empty").hidden = false; });
    }

    function refreshRunData(cb) {
      var mine = ++loadToken;
      var sum = selected();
      var base = baselineSummary();
      var needSel = sum && state.runFullHash !== sum.resultHash;
      var needBase = base && state.baselineHash !== base.resultHash;
      if (!base) { state.baselineFull = null; state.baselineHash = null; }
      if (!needSel && !needBase) { if (cb) cb(); return; }
      Promise.all([
        needSel ? api("/ops/lab/api/run/" + encodeURIComponent(sum.resultHash)) : Promise.resolve(null),
        needBase ? api("/ops/lab/api/run/" + encodeURIComponent(base.resultHash)) : Promise.resolve(null),
      ]).then(function (res) {
        if (mine !== loadToken) return;
        if (res[0] && res[0].ok && res[0].body && res[0].body.run) { state.runFull = res[0].body.run; state.runFullHash = sum.resultHash; }
        if (res[1] && res[1].ok && res[1].body && res[1].body.run) { state.baselineFull = res[1].body.run; state.baselineHash = base.resultHash; }
        if (cb) cb();
      });
    }

    /* ---------- left column ---------- */

    function renderWindows() {
      var g = $("lab-windows");
      g.innerHTML = "";
      state.windows.forEach(function (w, i) {
        var b = document.createElement("button");
        b.type = "button";
        b.textContent = w.label || w.windowId;
        b.setAttribute("aria-pressed", String(i === state.w));
        b.onclick = function () { pickWindow(i); };
        g.appendChild(b);
      });
    }
    function pickWindow(i) {
      state.w = i;
      state.at = 0;
      stopPlay();
      var base = baselineSummary();
      state.selectedHash = (base || runsOf()[0] || {}).resultHash || null;
      renderAll();
    }
    function renderCap() {
      var r = selected();
      var box = $("lab-cap");
      if (!r || !state.runFull || state.runFullHash !== r.resultHash) {
        box.innerHTML = '<div class="lab-k">Capital simulado</div><div class="lab-v lab-num">…</div>';
        return;
      }
      var p = state.runFull.series[Math.min(state.at, state.runFull.series.length - 1)];
      var m = r.metrics;
      box.innerHTML =
        '<div class="lab-k">Capital simulado · ' + esc(tF.format(p.t * 1000)) + "</div>" +
        '<div class="lab-v lab-num">' + esc(LAB.money(p.v)) + "<small>USDC</small></div>" +
        '<div class="lab-d"><span>al final <b class="lab-num">' + esc(LAB.money(m.end)) + '</b></span>' +
        '<span class="' + LAB.cls(m.vsHodl) + '">' + esc(LAB.sg(m.vsHodl)) + " frente a mantener</span>" +
        '<span class="' + LAB.cls(m.end - r.deposit) + '">' + esc(LAB.sg(m.end - r.deposit)) + " frente a USDC</span></div>";
    }
    function renderVariants() {
      var g = $("lab-variants");
      g.innerHTML = "";
      runsOf().forEach(function (r) {
        var b = document.createElement("button");
        b.className = "lab-var";
        b.type = "button";
        b.setAttribute("aria-pressed", String(r.resultHash === state.selectedHash));
        b.innerHTML = "<b>" + esc(r.variantLabel) + '</b><span class="lab-n ' + LAB.cls(r.metrics.vsHodl) + '">' + esc(LAB.sg(r.metrics.vsHodl)) + "</span><small>" + esc(r.policyId) + "</small>";
        b.title = "Resultado frente a mantener la mezcla";
        b.onclick = function () { state.selectedHash = r.resultHash; state.at = 0; stopPlay(); renderAll(); };
        g.appendChild(b);
      });
    }
    function renderAssum() {
      var r = selected();
      var w = windowOf();
      if (!r || !w) { $("lab-ass").innerHTML = ""; return; }
      var rows = [
        ["Depósito", LAB.money(r.deposit) + " USDC"],
        ["Ventana", dF.format(new Date(w.from)) + " a " + dF.format(new Date(w.to))],
        ["Tramo", w.split === "train" ? "entrenamiento" : w.split],
        ["Política", r.policyId],
        ["Base", r.specKey.split("|")[1] === "guard" ? "con guarda de caídas" : "política actual"],
        ["Ancho de rango", r.specKey.split("|")[2] + " ticks"],
        ["Resultado", r.resultHash.slice(0, 10) + "…"],
      ];
      $("lab-ass").innerHTML = rows.map(function (row) { return "<dt>" + esc(row[0]) + "</dt><dd>" + esc(row[1]) + "</dd>"; }).join("");
    }

    /* ---------- bench ---------- */

    function renderHead() {
      var r = selected();
      var w = windowOf();
      var head = $("lab-headline");
      if (!r || !w) { head.textContent = ""; return; }
      var vs = r.metrics.vsHodl;
      var txt = esc(w.label) + ": " + esc(r.variantLabel.toLowerCase()) + " termina <b>" + esc(LAB.money(Math.abs(vs))) + (vs >= 0 ? " por encima" : " por debajo") + "</b> de mantener la mezcla";
      var base = baselineSummary();
      if (base && base.resultHash !== r.resultHash && LAB.canCompareToBaseline(r, base)) {
        var d = r.metrics.end - base.metrics.end;
        txt += ", y <b>" + esc(LAB.money(Math.abs(d))) + (d >= 0 ? " mejor" : " peor") + "</b> que la política actual";
      }
      head.innerHTML = txt + ".";
    }
    function renderTiles() {
      var r = selected();
      var box = $("lab-tiles");
      if (!r) { box.innerHTML = ""; return; }
      var m = r.metrics;
      var tile = function (cls, lab, col, v, sub) {
        return '<div class="lab-tile ' + cls + '"><div class="lab-k"><i style="border-color:' + col + '"></i>' + esc(lab) + '</div><div class="lab-v lab-num">' + esc(LAB.money(v)) + '</div><div class="lab-s ' + LAB.cls(v - r.deposit) + '">' + esc(LAB.pct((v - r.deposit) / r.deposit, 2)) + (sub ? " · " + esc(sub) : "") + "</div></div>";
      };
      box.innerHTML =
        tile("lab-main", r.variantLabel, "var(--mamoru)", m.end, LAB.money(m.fees) + " en comisiones") +
        tile("", "Mantener", "var(--hold)", m.hodl, "sin tocar") +
        tile("", "USDC", "var(--usdc)", r.deposit, "no hacer nada");
    }
    function renderPoolTabs() {
      var g = $("lab-pooltabs");
      g.innerHTML = "";
      var r = selected();
      if (!r) return;
      POOL_ORDER.forEach(function (p) {
        if (r.pools.indexOf(p) === -1) return;
        var b = document.createElement("button");
        b.type = "button";
        b.textContent = POOLS[p].name;
        b.title = POOLS[p].pair;
        b.setAttribute("aria-pressed", String(p === state.pool));
        b.onclick = function () { state.pool = p; drawPrice(); drawCursor(); };
        g.appendChild(b);
      });
      if (r.pools.indexOf(state.pool) === -1) state.pool = r.pools[0];
    }

    function keyOpsOf(run) { return run ? LAB.keyOps(run.ops) : []; }

    function frame(box, height, pad) {
      box.innerHTML = "";
      var width = Math.max(260, box.clientWidth || 260);
      var s = svg("svg", { viewBox: "0 0 " + width + " " + height }, box);
      var series = state.runFull ? state.runFull.series : [];
      var t0 = series.length ? series[0].t : 0;
      var t1 = series.length ? series[series.length - 1].t : 1;
      var x = function (t) { return pad.l + ((t - t0) / (t1 - t0 || 1)) * (width - pad.l - pad.r); };
      return { svg: s, width: width, height: height, x: x, t0: t0, t1: t1, pad: pad };
    }
    function drawPrice() {
      var box = $("lab-price");
      if (!state.runFull) { box.innerHTML = '<p class="lab-note">Cargando…</p>'; return; }
      var r = state.runFull, pool = state.pool;
      var f = frame(box, box.clientWidth < 560 ? 220 : 270, { l: 52, r: 64, t: 26, b: 22 });
      var pts = r.series.filter(function (p) { return Number.isFinite(p.price[pool]); });
      if (!pts.length) { box.innerHTML = '<p class="lab-note">Sin datos de precio para este pool en esta ventana.</p>'; return; }
      var vals = [];
      pts.forEach(function (p) { vals.push(p.price[pool]); if (p.band[pool]) vals.push(p.band[pool][0], p.band[pool][1]); });
      if (state.baselineFull) state.baselineFull.series.forEach(function (p) { if (p.band[pool]) vals.push(p.band[pool][0], p.band[pool][1]); });
      var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
      var pad = (hi - lo) * 0.06 || hi * 0.001 || 1;
      lo -= pad; hi += pad;
      var y = function (v) { return f.pad.t + (1 - (v - lo) / (hi - lo)) * (f.height - f.pad.t - f.pad.b); };
      var g = svg("g", { class: "lab-axis" }, f.svg);
      LAB.ticks(lo, hi, 4).forEach(function (v) {
        svg("line", { x1: f.pad.l, x2: f.width - f.pad.r, y1: y(v), y2: y(v), stroke: cssVar("--grid") }, g);
        svg("text", { x: f.pad.l - 6, y: y(v) + 3.5, "text-anchor": "end" }, g).textContent = fp(v, pool);
      });
      var ppd = (f.width - f.pad.l - f.pad.r) / ((f.t1 - f.t0) / 86400 || 1);
      var every = [1, 2, 3, 7, 14].filter(function (k) { return k * ppd >= 56; })[0] || 14;
      for (var t = Math.ceil(f.t0 / 86400) * 86400; t <= f.t1; t += 86400 * every) {
        svg("text", { x: f.x(t), y: f.height - 5, "text-anchor": "middle" }, g).textContent = dF.format(t * 1000);
      }
      var flush = function (ss, fill, stroke, dash) {
        if (ss.length > 1) {
          var top = ss.map(function (p, i) { return (i ? "L" : "M") + f.x(p.t).toFixed(1) + "," + y(p.band[pool][1]).toFixed(1); }).join("");
          var bot = ss.slice().reverse().map(function (p) { return "L" + f.x(p.t).toFixed(1) + "," + y(p.band[pool][0]).toFixed(1); }).join("");
          svg("path", { d: top + bot + "Z", fill: fill, stroke: stroke, "stroke-width": 1, "stroke-dasharray": dash || "" }, f.svg);
        }
      };
      var seg = [];
      pts.forEach(function (p) { if (p.band[pool]) seg.push(p); else { flush(seg, cssVar("--band"), cssVar("--bandedge")); seg = []; } });
      flush(seg, cssVar("--band"), cssVar("--bandedge"));
      var selSum = selected(), baseSum = baselineSummary();
      if (state.baselineFull && selSum && baseSum && selSum.resultHash !== baseSum.resultHash) {
        seg = [];
        state.baselineFull.series.forEach(function (p) { if (p.band[pool]) seg.push(p); else { flush(seg, "none", cssVar("--ghost"), "4 3"); seg = []; } });
        flush(seg, "none", cssVar("--ghost"), "4 3");
      }
      svg("path", { d: pts.map(function (p, i) { return (i ? "L" : "M") + f.x(p.t).toFixed(1) + "," + y(p.price[pool]).toFixed(1); }).join(""), fill: "none", stroke: cssVar("--ink"), "stroke-width": 1.5, "stroke-linejoin": "round" }, f.svg);
      var near = function (t) {
        var q = pts[0];
        pts.forEach(function (p) { if (Math.abs(p.t - t) < Math.abs(q.t - t)) q = p; });
        return q;
      };
      keyOpsOf(r).filter(function (o) { return o.pool === pool; }).forEach(function (o) {
        var cx = f.x(o.t), cy = y(near(o.t).price[pool]);
        if (o.kind === "rerange") svg("path", { d: "M" + cx + "," + (cy - 5) + " l4.5,8 h-9 Z", fill: cssVar("--loss"), stroke: cssVar("--paper"), "stroke-width": 1.5 }, f.svg);
        else if (o.kind === "harvest") svg("circle", { cx: cx, cy: cy, r: 3.2, fill: cssVar("--mamoru"), stroke: cssVar("--paper"), "stroke-width": 1.5 }, f.svg);
        else svg("path", { d: "M" + cx + "," + (cy - 4.5) + " l4.5,4.5 l-4.5,4.5 l-4.5,-4.5 Z", fill: cssVar("--ink"), stroke: cssVar("--paper"), "stroke-width": 1.5 }, f.svg);
      });
      var last = pts[pts.length - 1];
      svg("text", { class: "lab-lblb", x: f.width - f.pad.r + 6, y: y(last.price[pool]) + 4 }, f.svg).textContent = fp(last.price[pool], pool);
      geo.price = { f: f, y: y };
      hoverOn(f, "price");
    }
    function drawMoney() {
      var box = $("lab-money");
      if (!state.runFull) { box.innerHTML = '<p class="lab-note">Cargando…</p>'; return; }
      var r = state.runFull, d = r.deposit;
      var f = frame(box, box.clientWidth < 560 ? 170 : 190, { l: 52, r: 64, t: 10, b: 22 });
      var vals = [];
      r.series.forEach(function (p) { vals.push(p.v, p.h); });
      if (state.baselineFull) state.baselineFull.series.forEach(function (p) { vals.push(p.v); });
      vals.push(d);
      var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
      var pad = (hi - lo) * 0.08 || 1;
      lo -= pad; hi += pad;
      var y = function (v) { return f.pad.t + (1 - (v - lo) / (hi - lo)) * (f.height - f.pad.t - f.pad.b); };
      var g = svg("g", { class: "lab-axis" }, f.svg);
      LAB.ticks(lo, hi, 4).forEach(function (v) {
        svg("line", { x1: f.pad.l, x2: f.width - f.pad.r, y1: y(v), y2: y(v), stroke: cssVar("--grid") }, g);
        svg("text", { x: f.pad.l - 6, y: y(v) + 3.5, "text-anchor": "end" }, g).textContent = new Intl.NumberFormat("es-ES").format(Math.round(v));
      });
      svg("line", { x1: f.pad.l, x2: f.width - f.pad.r, y1: y(d), y2: y(d), stroke: cssVar("--usdc"), "stroke-width": 1.5, "stroke-dasharray": "1 4", "stroke-linecap": "round" }, f.svg);
      var path = function (s, k) { return s.map(function (p, i) { return (i ? "L" : "M") + f.x(p.t).toFixed(1) + "," + y(p[k]).toFixed(1); }).join(""); };
      svg("path", { d: path(r.series, "h"), fill: "none", stroke: cssVar("--hold"), "stroke-width": 1.8 }, f.svg);
      var selSum = selected(), baseSum = baselineSummary();
      if (state.baselineFull && selSum && baseSum && selSum.resultHash !== baseSum.resultHash) {
        svg("path", { d: path(state.baselineFull.series, "v"), fill: "none", stroke: cssVar("--ghost"), "stroke-width": 1.5, "stroke-dasharray": "4 3" }, f.svg);
      }
      svg("path", { d: path(r.series, "v"), fill: "none", stroke: cssVar("--mamoru"), "stroke-width": 2.2 }, f.svg);
      geo.money = { f: f, y: y };
      hoverOn(f, "money");
    }
    function hoverOn(f, which) {
      var hit = svg("rect", { x: f.pad.l, y: 0, width: Math.max(0, f.width - f.pad.l - f.pad.r), height: f.height, fill: "transparent", style: "cursor:crosshair" }, f.svg);
      var pick = function (ev) {
        var rc = f.svg.getBoundingClientRect();
        var px = ((ev.clientX - rc.left) / rc.width) * f.width;
        var t = f.t0 + ((px - f.pad.l) / (f.width - f.pad.l - f.pad.r || 1)) * (f.t1 - f.t0);
        return LAB.nearestIndex(state.runFull ? state.runFull.series : [], t);
      };
      hit.addEventListener("pointerdown", function (ev) { stopPlay(); state.at = pick(ev); tickAll(); });
      hit.addEventListener("pointermove", function (ev) { if (ev.buttons) { state.at = pick(ev); tickAll(); } });
    }
    function drawCursor() {
      if (!state.runFull || !state.runFull.series.length) return;
      var at = Math.min(state.at, state.runFull.series.length - 1);
      var p = state.runFull.series[at];
      ["price", "money"].forEach(function (k) {
        var g = geo[k];
        if (!g) return;
        var old = g.f.svg.querySelector(".lab-cur");
        if (old) old.remove();
        var cur = svg("g", { class: "lab-cur", "pointer-events": "none" }, g.f.svg);
        svg("line", { x1: g.f.x(p.t), x2: g.f.x(p.t), y1: g.f.pad.t - 4, y2: g.f.height - g.f.pad.b, stroke: cssVar("--ink"), "stroke-width": 1, opacity: 0.35 }, cur);
        if (k === "price" && Number.isFinite(p.price[state.pool])) svg("circle", { cx: g.f.x(p.t), cy: g.y(p.price[state.pool]), r: 4, fill: cssVar("--ink"), stroke: cssVar("--paper"), "stroke-width": 2 }, cur);
        if (k === "money") {
          svg("circle", { cx: g.f.x(p.t), cy: g.y(p.v), r: 4, fill: cssVar("--mamoru"), stroke: cssVar("--paper"), "stroke-width": 2 }, cur);
          svg("circle", { cx: g.f.x(p.t), cy: g.y(p.h), r: 3.5, fill: cssVar("--hold"), stroke: cssVar("--paper"), "stroke-width": 2 }, cur);
        }
      });
    }
    function renderNarr() {
      var box = $("lab-narr");
      if (!state.runFull || !state.runFull.series.length) { box.innerHTML = ""; return; }
      var r = state.runFull;
      var at = Math.min(state.at, r.series.length - 1);
      var p = r.series[at];
      var band = p.band[state.pool], price = p.price[state.pool];
      var last = r.ops.filter(function (o) { return o.t <= p.t && o.kind !== "enter_swap"; }).slice(-1)[0];
      var inside = band && price >= band[0] && price <= band[1];
      var poolName = (POOLS[state.pool] || {}).name || state.pool;
      var stateTxt = !band
        ? poolName + ": sin posición todavía."
        : inside
        ? poolName + " está dentro del rango (" + fp(band[0], state.pool) + " a " + fp(band[1], state.pool) + "): la posición cobra comisiones."
        : poolName + " está fuera del rango: la posición no cobra hasta que Mamoru recentre.";
      var diff = p.v - p.h;
      box.innerHTML =
        '<span class="lab-when">' + esc(tF.format(p.t * 1000)) + " UTC" + (last ? " · último movimiento: " + esc((POOLS[last.pool] || {}).name || last.pool) + " " + esc(KIND[last.kind] || last.kind) + " (" + esc(tF.format(last.t * 1000)) + ")" : "") + "</span>" +
        "<span>" + esc(stateTxt) + ' Tu dinero va <b class="' + LAB.cls(diff) + '">' + esc(LAB.sg(diff)) + "</b> frente a mantener.</span>";
    }
    function renderTicks() {
      if (!state.runFull) return;
      var r = state.runFull, s = r.series;
      if (!s.length) return;
      var t0 = s[0].t, t1 = s[s.length - 1].t;
      var g = $("lab-ticks");
      g.innerHTML = "";
      keyOpsOf(r).forEach(function (o) {
        var sp = document.createElement("span");
        sp.style.left = (((o.t - t0) / (t1 - t0 || 1)) * 100) + "%";
        sp.style.background = o.kind === "rerange" ? cssVar("--loss") : o.kind === "harvest" ? cssVar("--mamoru") : cssVar("--ink2");
        g.appendChild(sp);
      });
      var scrub = $("lab-scrub");
      scrub.max = String(s.length - 1);
      scrub.value = String(Math.min(state.at, s.length - 1));
    }

    /* ---------- bottom tabs ---------- */

    function renderEvents() {
      if (!state.runFull) { $("lab-t-ev").innerHTML = ""; return; }
      var r = state.runFull, s = r.series;
      var at = Math.min(state.at, s.length - 1);
      var p = s[at];
      var ev = keyOpsOf(r);
      var cur = ev.filter(function (o) { return o.t <= p.t; }).slice(-1)[0];
      var rows = ev
        .map(function (o, i) {
          var pool = POOLS[o.pool] || { name: o.pool };
          return (
            '<button type="button" class="lab-ev' + (o === cur ? " lab-cur" : "") + '" data-i="' + i + '"><span class="lab-t">' + esc(tF.format(o.t * 1000)) +
            '</span><span class="lab-p">' + esc(pool.name) + "</span><span>" + esc(KIND[o.kind] || o.kind) + '</span><span class="lab-m">' +
            (o.fees ? '<span class="lab-pos">+' + esc(LAB.money(o.fees)) + "</span> · " : "") + "gas " + esc(LAB.money(o.gas)) + "</span></button>"
          );
        })
        .join("");
      $("lab-t-ev").innerHTML = '<div class="lab-evlist">' + (rows || '<p class="lab-note">Sin movimientos en esta ventana.</p>') + "</div>";
      $("lab-t-ev").querySelectorAll(".lab-ev").forEach(function (b) {
        b.onclick = function () {
          var o = ev[Number(b.getAttribute("data-i"))];
          state.pool = o.pool;
          state.at = LAB.idxAt(s, o.t);
          stopPlay();
          renderPoolTabs();
          drawPrice();
          tickAll();
        };
      });
    }
    function renderCompare() {
      var box = $("lab-t-cmp");
      var w = windowOf();
      if (!w) { box.innerHTML = ""; return; }
      var rows = runsOf()
        .map(function (r) {
          return (
            '<tr class="' + (r.resultHash === state.selectedHash ? "lab-cur" : "") + '"><td>' + esc(r.variantLabel) + "</td><td>" + esc(LAB.money(r.metrics.end)) +
            '</td><td class="' + LAB.cls(r.metrics.vsHodl) + '">' + esc(LAB.sg(r.metrics.vsHodl)) + '</td><td class="lab-pos">' + esc(LAB.money(r.metrics.fees)) +
            "</td><td>" + esc(LAB.money(r.metrics.gas)) + "</td><td>" + esc(String(Object.values(r.metrics.operations).reduce(function (a, n) { return a + n; }, 0))) +
            "</td><td>−" + esc((r.metrics.maxDrawdownBps / 100).toFixed(1)) + " %</td></tr>"
          );
        })
        .join("");
      var matrixRows = LAB.compareMatrix(state.windows);
      var mat = matrixRows
        .map(function (row) {
          var cells = state.windows
            .map(function (win) {
              var x = row.byWindow[win.windowId];
              if (x === undefined || x === null) return "<td>—</td>";
              var a = Math.min(1, Math.abs(x) / 20);
              var bg = x >= 0 ? "rgba(19,128,90," + (a * 0.35).toFixed(2) + ")" : "rgba(155,44,44," + (a * 0.35).toFixed(2) + ")";
              return '<td><span class="lab-cell" style="background:' + bg + '">' + esc(LAB.sg(x)) + "</span></td>";
            })
            .join("");
          return "<tr><td>" + esc(row.variantLabel) + "</td>" + cells + "</tr>";
        })
        .join("");
      box.innerHTML =
        '<div class="lab-tbl"><table><thead><tr><th>' + esc(w.label) + "</th><th>Final</th><th>vs mantener</th><th>Comisiones</th><th>Gas</th><th>Operaciones</th><th>Peor caída</th></tr></thead><tbody>" + rows + "</tbody></table></div>" +
        '<div class="lab-tbl" style="margin-top:18px"><table><thead><tr><th>Frente a mantener, por ventana</th>' + state.windows.map(function (win) { return "<th>" + esc(win.label) + "</th>"; }).join("") + "</tr></thead><tbody>" + mat + "</tbody></table></div>" +
        '<p class="lab-note" style="margin-top:8px">Una estrategia que gana en una ventana y pierde en otra no está validada: mira todas las ventanas a la vez.</p>';
    }
    function renderDiag() {
      var box = $("lab-t-dg");
      var r = selected();
      if (!r || !state.runFull || state.runFullHash !== r.resultHash) { box.innerHTML = '<p class="lab-note">Cargando…</p>'; return; }
      var full = state.runFull;
      var reasons = Object.entries(full.reasons || {}).sort(function (a, b) { return b[1] - a[1]; });
      var tot = reasons.reduce(function (a, kv) { return a + kv[1]; }, 0) || 1;
      var opsE = Object.entries(r.metrics.operations).filter(function (kv) { return kv[1]; });
      box.innerHTML =
        '<div class="lab-diag"><div style="display:grid;gap:6px"><div class="lab-k">Qué decidió en cada revisión</div>' +
        reasons.map(function (kv) { return '<div class="lab-bar" title="' + esc(kv[0]) + '"><span>' + esc(REASON[kv[0]] || kv[0]) + '</span><span class="lab-mono lab-num" style="text-align:right">' + ((kv[1] / tot) * 100).toFixed(1) + " %</span></div>"; }).join("") +
        '</div><div style="display:grid;gap:6px"><div class="lab-k">Operaciones</div>' +
        opsE.map(function (kv) { return '<div class="lab-bar"><span>' + esc(KIND[kv[0]] || kv[0]) + '</span><span class="lab-mono lab-num" style="text-align:right">' + esc(String(kv[1])) + "</span></div>"; }).join("") +
        '</div><div style="display:grid;gap:6px"><div class="lab-k">Riesgo</div>' +
        '<div class="lab-bar"><span>Tiempo en rango</span><span class="lab-mono lab-num" style="text-align:right">' + Math.round(r.metrics.timeInRangeBps / 100) + " %</span></div>" +
        '<div class="lab-bar"><span>Peor caída</span><span class="lab-mono lab-num" style="text-align:right">−' + (r.metrics.maxDrawdownBps / 100).toFixed(1) + " %</span></div>" +
        '<div class="lab-bar"><span>Gas sobre comisiones</span><span class="lab-mono lab-num" style="text-align:right">' + Math.round((r.metrics.gas / Math.max(r.metrics.fees, 0.01)) * 100) + " %</span></div>" +
        '</div></div><p class="lab-note lab-mono" style="margin-top:10px">Resultado ' + esc(r.resultHash.slice(0, 18)) + "… · simVersion " + esc(r.simVersion) + " · simulación sobre historia real de Base.</p>";
    }
    function setTab(t) {
      state.tab = t;
      scope.querySelectorAll(".lab-tab").forEach(function (b) { b.setAttribute("aria-selected", String(b.getAttribute("data-lab-t") === t)); });
      ["ev", "cmp", "dg"].forEach(function (k) { $("lab-t-" + k).hidden = k !== t; });
      if (t === "ev") renderEvents();
      else if (t === "cmp") renderCompare();
      else renderDiag();
    }
    function setRTab(t) {
      state.rtab = t;
      scope.querySelectorAll(".lab-rtabs button").forEach(function (b) { b.setAttribute("aria-selected", String(b.getAttribute("data-lab-r") === t)); });
      $("lab-r-probar").hidden = t !== "probar";
      $("lab-r-preguntar").hidden = t !== "preguntar";
    }

    /* ---------- right: Probar (B-07, B-08) ---------- */

    function renderProbar() {
      var box = $("lab-r-probar");
      var w = windowOf();
      box.innerHTML =
        '<div class="lab-field"><label>Base</label><div class="lab-seg" id="lab-base"></div></div>' +
        '<div class="lab-field"><label for="lab-width">Ancho del rango <span id="lab-width-v">' + state.probe.width + " ticks</span></label>" +
        '<input id="lab-width" type="range" min="' + LAB.WIDTH_MIN + '" max="' + LAB.WIDTH_MAX + '" step="' + LAB.WIDTH_STEP + '" value="' + state.probe.width + '" />' +
        '<div class="lab-scale"><span>estrecho, cobra más</span><span>ancho, aguanta más</span></div></div>' +
        '<div class="lab-field"><label for="lab-deposit">Depósito <span id="lab-deposit-v">' + state.probe.deposit + " USDC</span></label>" +
        '<input id="lab-deposit" type="range" min="' + LAB.DEPOSIT_MIN + '" max="' + LAB.DEPOSIT_MAX + '" step="100" value="' + state.probe.deposit + '" />' +
        '<div class="lab-scale"><span>' + LAB.DEPOSIT_MIN + '</span><span>' + LAB.DEPOSIT_MAX + ' USDC</span></div></div>' +
        '<div class="lab-field lab-later"><label>Choque de precio sintético</label><input type="range" disabled /></div>' +
        '<button type="button" class="lab-run" id="lab-run"' + (w ? "" : " disabled") + '>Ejecutar escenario</button>' +
        '<p class="lab-note">"Ejecutar escenario" encola un trabajo para el runner; esta columna muestra su estado y selecciona la estrategia cuando termina. Lo marcado «más adelante» necesita el generador de escenarios.</p>';
      var baseSeg = $("lab-base");
      ["live", "guard"].forEach(function (b) {
        var allowed = !w || w.bases.indexOf(b) !== -1;
        var btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = b === "guard" ? "Con guarda de caídas" : "Política actual";
        btn.setAttribute("aria-pressed", String(state.probe.base === b));
        btn.disabled = !allowed;
        btn.onclick = function () { state.probe.base = b; renderProbar(); };
        baseSeg.appendChild(btn);
      });
      $("lab-width").oninput = function (e) { state.probe.width = Math.round(Number(e.target.value) / LAB.WIDTH_STEP) * LAB.WIDTH_STEP; $("lab-width-v").textContent = state.probe.width + " ticks"; };
      $("lab-deposit").oninput = function (e) { state.probe.deposit = Math.round(Number(e.target.value)); $("lab-deposit-v").textContent = state.probe.deposit + " USDC"; };
      $("lab-run").onclick = runScenario;
      renderJob();
    }

    function runScenario() {
      var w = windowOf();
      if (!w) return;
      var spec = { windowId: w.windowId, base: state.probe.base, widthTicks: state.probe.width, deposit: state.probe.deposit };
      if (!LAB.validSpec(spec)) return;
      var btn = $("lab-run");
      if (btn) btn.disabled = true;
      var body = new URLSearchParams({ csrf: csrf, windowId: spec.windowId, base: spec.base, widthTicks: String(spec.widthTicks), deposit: String(spec.deposit) }).toString();
      api("/ops/lab/api/jobs", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body })
        .then(function (r) {
          if (btn) btn.disabled = false;
          if (!r.ok || !r.body || !r.body.job) {
            state.job = { status: "failed", errorCode: (r.body && r.body.error) || "LAB_NETWORK" };
            renderJob();
            return;
          }
          state.job = r.body.job;
          state.jobStart = Date.now();
          renderJob();
          if (state.job.status === "done") onJobDone(state.job);
          else pollJob(state.job.id, 0);
        })
        .catch(function () {
          if (btn) btn.disabled = false;
          state.job = { status: "failed", errorCode: "LAB_NETWORK" };
          renderJob();
        });
    }
    function pollJob(id, attempt) {
      clearTimeout(jobTimer);
      jobTimer = setTimeout(function () {
        api("/ops/lab/api/jobs/" + encodeURIComponent(id)).then(function (r) {
          if (!state.job || state.job.id !== id) return;
          if (!r.ok || !r.body || !r.body.job) { pollJob(id, attempt + 1); return; }
          state.job = r.body.job;
          renderJob();
          if (state.job.status === "queued" || state.job.status === "running") pollJob(id, attempt + 1);
          else if (state.job.status === "done") onJobDone(state.job);
        });
      }, LAB.pollDelayMs(attempt));
    }
    function onJobDone(job) {
      var w = windowOf();
      if (!w) return;
      api("/ops/lab/api/runs?window=" + encodeURIComponent(w.windowId)).then(function (rr) {
        w.runs = (rr.body && rr.body.runs) || w.runs;
        state.selectedHash = job.resultHash || state.selectedHash;
        state.job = null;
        state.at = 0;
        renderAll();
      });
    }
    function renderJob() {
      var box = $("lab-job");
      if (!box) return;
      if (!state.job) { box.hidden = true; return; }
      box.hidden = false;
      box.className = "lab-jobline" + (state.job.status === "failed" ? " lab-failed" : "");
      if (state.job.status === "queued" || state.job.status === "running") {
        var secs = Math.max(0, Math.round((Date.now() - state.jobStart) / 1000));
        box.textContent = (state.job.status === "queued" ? "En cola" : "Corriendo") + "… " + secs + " s";
      } else if (state.job.status === "failed") {
        box.textContent = "Falló: " + (ERROR_WORDS[state.job.errorCode] || state.job.errorCode || "motivo desconocido");
      } else {
        box.hidden = true;
      }
    }

    /* ---------- playback ---------- */

    function stopPlay() {
      state.playing = false;
      clearTimeout(playTimer);
      var b = $("lab-play");
      if (b) b.textContent = "Reproducir";
    }
    function stepPlay() {
      if (!state.playing || !state.runFull) return;
      var n = state.runFull.series.length - 1;
      if (state.at >= n) { stopPlay(); return; }
      state.at = Math.min(n, state.at + state.speed);
      tickAll();
      playTimer = setTimeout(stepPlay, 90);
    }
    function jump(dir) {
      stopPlay();
      if (!state.runFull) return;
      var ev = keyOpsOf(state.runFull);
      var t = state.runFull.series[Math.min(state.at, state.runFull.series.length - 1)].t;
      var o = dir > 0 ? ev.filter(function (e) { return e.t > t + 1; })[0] : ev.filter(function (e) { return e.t < t - 1; }).slice(-1)[0];
      if (o) { state.pool = o.pool; state.at = LAB.idxAt(state.runFull.series, o.t); renderPoolTabs(); drawPrice(); tickAll(); }
    }

    function tickAll() {
      renderCap();
      drawCursor();
      renderNarr();
      renderTicks();
      if (state.tab === "ev") renderEvents();
    }
    function drawCharts() {
      drawPrice();
      drawMoney();
      renderTicks();
      tickAll();
    }
    function renderAll() {
      renderWindows();
      renderVariants();
      renderAssum();
      renderHead();
      renderTiles();
      renderPoolTabs();
      renderProbar();
      refreshRunData(drawCharts);
      setTab(state.tab);
    }

    function wire() {
      scope.querySelectorAll(".lab-tab").forEach(function (b) { b.onclick = function () { setTab(b.getAttribute("data-lab-t")); }; });
      scope.querySelectorAll(".lab-rtabs button").forEach(function (b) { b.onclick = function () { setRTab(b.getAttribute("data-lab-r")); }; });
      var play = $("lab-play");
      if (play) play.onclick = function () {
        if (state.playing) { stopPlay(); return; }
        if (!state.runFull) return;
        if (state.at >= state.runFull.series.length - 1) state.at = 0;
        state.playing = true;
        play.textContent = "Pausa";
        stepPlay();
      };
      var speed = $("lab-speed");
      if (speed) speed.onclick = function () { state.speed = state.speed === 1 ? 4 : state.speed === 4 ? 12 : 1; speed.textContent = state.speed + "×"; };
      var next = $("lab-next"); if (next) next.onclick = function () { jump(1); };
      var prev = $("lab-prev"); if (prev) prev.onclick = function () { jump(-1); };
      var scrub = $("lab-scrub"); if (scrub) scrub.oninput = function (e) { stopPlay(); state.at = Number(e.target.value); tickAll(); };
    }

    function init(s) {
      root = s.closest(".lab-root") || s.querySelector(".lab-root");
      if (!root) return function () {};
      scope = s;
      csrf = root.getAttribute("data-lab-csrf") || "";
      state = freshState();
      geo = {};
      wire();
      loadAll();
      var onResize = function () { drawPrice(); drawMoney(); drawCursor(); };
      var resizeTimer;
      var onResizeDebounced = function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(onResize, 150); };
      window.addEventListener("resize", onResizeDebounced);
      return function () {
        clearTimeout(playTimer);
        clearTimeout(jobTimer);
        clearTimeout(resizeTimer);
        window.removeEventListener("resize", onResizeDebounced);
        loadToken++;
        root = null;
        scope = null;
        state = null;
      };
    }

    return { init: init };
  })();

  var modules = {
    overview: function (scope, quiet) { return mountMotion(scope, quiet); },
    mails: function (scope, quiet) { return mountMotion(scope, quiet); },
    experiments: function (scope, quiet) { return mountMotion(scope, quiet); },
    settings: function (scope, quiet) { return mountMotion(scope, quiet); },
    lab: function (scope) { return LabApp.init(scope); },
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
    // otto/mamoru-astro#24: the console client draws charts and wires the account drawer after every swap.
    try { document.dispatchEvent(new CustomEvent("ops:mounted", { detail: { scope: main, section: view.section } })); } catch (err) {}
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
      // A form whose POST may already have written something is never sent again behind the reader's back: the
      // first request can have committed and only its answer been lost.
      if (form.hasAttribute("data-ops-no-retry")) {
        for (var k = 0; k < buttons.length; k++) buttons[k].disabled = false;
        announce("No answer from the server. Nothing was sent again: check the history before submitting once more.");
        return;
      }
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
