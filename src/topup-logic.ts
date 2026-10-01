/**
 * Pure logic of the relayer top-up widget: amount parsing, fee and affordability
 * math, wallet-error sentences, and the state → view mapping.
 *
 * One self-contained factory on purpose. The page embeds `topupLogic.toString()`
 * in its inline script and the tests call the same function, so the tested code is
 * the shipped code. Nothing in here may reference anything outside the function.
 */

export type TopupPhase =
  | "nowallet"
  | "idle"
  | "connecting"
  | "wrongnet"
  | "ready"
  | "confirm"
  | "signing"
  | "sent"
  | "confirmed"
  | "failed";

export interface TopupState {
  phase: TopupPhase;
  account: string | null;
  /** Wallet balance on Base, wei. null while it is being read. */
  balance: bigint | null;
  /** Estimated network fee for one plain transfer, wei. */
  fee: bigint | null;
  amountText: string;
  hash: string | null;
  error: string;
  /** True once confirmation has taken longer than the polling window. */
  slow: boolean;
  /** Where "Try again" returns to after a failure. */
  failedTo: TopupPhase;
}

export interface TopupContext {
  relayer: string;
  /** What one new account costs the relayer, wei. null when not known. */
  costWei: bigint | null;
  ethUsd: number | null;
}

export interface TopupAction {
  label: string;
  action: string;
  enabled: boolean;
}

export interface TopupView {
  step: 1 | 2 | 3;
  tone: "plain" | "warn" | "good" | "bad";
  line: string;
  detail: string;
  /** "0xb343…53e1 · 0.0025 ETH on Base", or "" when no wallet is connected. */
  wallet: string;
  /** Live reading of the typed amount: "$13.43 · funds 7 more accounts". */
  hint: string;
  amountLocked: boolean;
  primary: TopupAction | null;
  secondary: TopupAction | null;
  /** A one-press fix for an unaffordable amount. */
  offer: { label: string; amountText: string } | null;
  link: { href: string; text: string } | null;
}

export function topupLogic() {
  var WEI = BigInt("1000000000000000000");
  var ZERO = BigInt(0);
  var TRANSFER_GAS = BigInt(21000);
  // Base adds an L1 data fee the wallet's gas price does not include; this covers it with room.
  var L1_FEE_MARGIN = BigInt("2000000000000");
  var BASE_CHAIN_HEX = "0x2105";

  var pow10 = function (n: number) {
    var out = BigInt(1);
    for (var i = 0; i < n; i++) out = out * BigInt(10);
    return out;
  };

  /** "0,005" and "0.005" both parse. Exponents, signs, separators and >18 decimals do not. */
  var parseEth = function (text: unknown): { ok: true; wei: bigint } | { ok: false; reason: string } {
    var raw = String(text === null || text === undefined ? "" : text).trim();
    if (raw === "") return { ok: false, reason: "empty" };
    var first = raw.charAt(0);
    if (first === "-" || first === "−") return { ok: false, reason: "negative" };
    var hasComma = raw.indexOf(",") !== -1;
    var hasDot = raw.indexOf(".") !== -1;
    if (hasComma && hasDot) return { ok: false, reason: "format" };
    var plain = raw.replace(",", ".");
    if (!/^\d*\.?\d*$/.test(plain) || !/\d/.test(plain)) return { ok: false, reason: "format" };
    var parts = plain.split(".");
    var whole = parts[0] || "0";
    var frac = parts[1] || "";
    if (frac.length > 18) return { ok: false, reason: "decimals" };
    if (whole.length > 9) return { ok: false, reason: "format" };
    var wei = BigInt(whole) * WEI + BigInt((frac + "000000000000000000").slice(0, 18));
    if (wei === ZERO) return { ok: false, reason: "zero" };
    return { ok: true, wei: wei };
  };

  /** Decimal ETH with trailing zeros trimmed. Rounds down unless `up` is set. */
  var formatEth = function (wei: bigint, decimals?: number, up?: boolean) {
    var d = decimals === undefined ? 6 : decimals;
    var unit = pow10(18 - d);
    var q = wei / unit;
    if (up && wei % unit !== ZERO) q = q + BigInt(1);
    var scale = pow10(d);
    var fracText = (q % scale).toString();
    while (fracText.length < d) fracText = "0" + fracText;
    fracText = fracText.replace(/0+$/, "");
    return (q / scale).toString() + (fracText ? "." + fracText : "");
  };

  /** 21000 gas at twice the wallet's gas price, plus the L1 data fee margin. */
  var estimateFee = function (gasPriceWei: bigint) {
    var price = gasPriceWei > ZERO ? gasPriceWei : ZERO;
    return TRANSFER_GAS * price * BigInt(2) + L1_FEE_MARGIN;
  };

  /** The largest amount that still leaves the fee behind, floored to six decimals. */
  var maxSend = function (balance: bigint, fee: bigint) {
    var room = balance - fee;
    if (room <= ZERO) return ZERO;
    var unit = pow10(12);
    return (room / unit) * unit;
  };

  var afford = function (balance: bigint, amount: bigint, fee: bigint) {
    var need = amount + fee;
    return { ok: balance >= need, need: need, max: maxSend(balance, fee) };
  };

  var fundsAccounts = function (wei: bigint, costWei: bigint | null) {
    if (costWei === null || costWei <= ZERO) return null;
    return Number(wei / costWei);
  };

  var usdText = function (wei: bigint, ethUsd: number | null) {
    if (ethUsd === null || !(ethUsd > 0)) return "";
    var usd = (Number(wei / pow10(9)) / 1e9) * ethUsd;
    return "$" + (usd >= 1000 ? Math.round(usd).toLocaleString("en-US") : usd.toFixed(2));
  };

  var toHex = function (wei: bigint) {
    return "0x" + wei.toString(16);
  };

  var fromHex = function (hex: unknown) {
    try {
      return BigInt(String(hex));
    } catch (err) {
      return null;
    }
  };

  var shortAddress = function (address: string | null) {
    var a = String(address || "");
    return a.length > 12 ? a.slice(0, 6) + "…" + a.slice(-4) : a;
  };

  /** Wallet errors as plain sentences. The wallet's own words are kept only for the unknown case. */
  var explain = function (err: unknown) {
    var e = (err || {}) as { code?: unknown; message?: unknown; data?: { message?: unknown } };
    var code = Number(e.code);
    var message = String(e.message || (e.data && e.data.message) || "").trim();
    var lower = message.toLowerCase();
    if (code === 4001 || /user rejected|user denied|rejected the request|cancel/.test(lower)) {
      return "You declined the request in the wallet. Nothing was sent.";
    }
    if (code === -32002 || /already pending|already processing/.test(lower)) {
      return "The wallet already has a request waiting. Open the wallet, finish or dismiss it, then try again.";
    }
    if (/insufficient funds|insufficient balance|not enough/.test(lower)) {
      return "The wallet says it does not have enough ETH for this amount plus the network fee.";
    }
    if (code === 4902 || code === 4901 || /unrecognized chain|chain.*not.*added|wrong network|chain mismatch/.test(lower)) {
      return "The wallet is not on Base. Switch it to Base and try again.";
    }
    if (code === 4100 || /unauthorized|locked/.test(lower)) {
      return "The wallet is locked or has not approved this site. Unlock it and connect again.";
    }
    if (!message) return "The wallet returned an error without saying why. Nothing was sent.";
    return "The wallet returned an error: " + (message.length > 160 ? message.slice(0, 160) + "…" : message);
  };

  var REASONS: Record<string, string> = {
    format: "That is not an amount. Use digits, like 0.005.",
    negative: "The amount cannot be negative.",
    decimals: "ETH has 18 decimal places at most.",
    zero: "The amount has to be more than zero.",
  };

  var amountHint = function (amountText: string, ctx: TopupContext) {
    var parsed = parseEth(amountText);
    if (!parsed.ok) return "";
    var bits: string[] = [];
    var usd = usdText(parsed.wei, ctx.ethUsd);
    if (usd) bits.push(usd);
    var n = fundsAccounts(parsed.wei, ctx.costWei);
    if (n !== null) bits.push("funds " + n + " more " + (n === 1 ? "account" : "accounts"));
    return bits.join(" · ");
  };

  /** Everything the widget shows for a state. The script only copies this onto the page. */
  var view = function (state: TopupState, ctx: TopupContext): TopupView {
    var out: TopupView = {
      step: 1,
      tone: "plain",
      line: "",
      detail: "",
      wallet: "",
      hint: amountHint(state.amountText, ctx),
      amountLocked: false,
      primary: null,
      secondary: null,
      offer: null,
      link: null,
    };
    var connected = Boolean(state.account) && state.phase !== "nowallet" && state.phase !== "idle" && state.phase !== "connecting";
    if (connected) {
      out.wallet =
        shortAddress(state.account) +
        (state.phase === "wrongnet"
          ? " · not on Base"
          : state.balance === null
            ? " · reading balance"
            : " · " + formatEth(state.balance) + " ETH on Base");
    }
    var parsed = parseEth(state.amountText);
    var amount = parsed.ok ? formatEth(parsed.wei, 18) : "";
    var txLink = state.hash ? { href: "https://basescan.org/tx/" + state.hash, text: "View " + shortAddress(state.hash) + " on Basescan" } : null;

    if (state.phase === "nowallet") {
      out.line = "No wallet found in this browser.";
      out.detail = "Open this page inside a wallet's browser, or install one and reload. You can also send from anywhere with the address below.";
      out.primary = { label: "Look again", action: "detect", enabled: true };
      return out;
    }
    if (state.phase === "idle") {
      out.line = "Connect the wallet you want to send from.";
      out.detail = "Nothing is sent until you confirm an amount.";
      out.primary = { label: "Connect wallet", action: "connect", enabled: true };
      return out;
    }
    if (state.phase === "connecting") {
      out.line = "Waiting for the wallet to connect.";
      out.detail = "Approve the request in your wallet.";
      out.secondary = { label: "Go back", action: "reset", enabled: true };
      return out;
    }
    if (state.phase === "wrongnet") {
      out.tone = "warn";
      out.line = "The wallet is on another network.";
      out.detail = "The relayer lives on Base. Switching does not send anything.";
      out.primary = { label: "Switch to Base", action: "switch", enabled: true };
      return out;
    }
    if (state.phase === "ready") {
      out.step = 2;
      out.primary = { label: "Send to relayer", action: "review", enabled: false };
      if (!parsed.ok) {
        out.line = parsed.reason === "empty" ? "Choose how much to send." : REASONS[parsed.reason] || REASONS.format;
        if (parsed.reason !== "empty") out.tone = "warn";
        return out;
      }
      if (state.balance === null || state.fee === null) {
        out.line = "Reading the wallet's balance on Base.";
        return out;
      }
      var check = afford(state.balance, parsed.wei, state.fee);
      if (!check.ok) {
        out.tone = "warn";
        out.line =
          "This wallet has " + formatEth(state.balance) + " ETH on Base. Sending " + amount + " ETH needs about " + formatEth(check.need, 5, true) + ".";
        if (check.max > ZERO) {
          var most = formatEth(check.max);
          out.detail = "The most it can send is " + most + " ETH.";
          out.offer = { label: "Use " + most + " ETH", amountText: most };
        } else {
          out.detail = "It cannot cover the network fee. Add ETH to it on Base first, or send from another wallet with the address below.";
        }
        return out;
      }
      out.line = "Ready to send " + amount + " ETH to the relayer.";
      out.detail = "Network fee about " + formatEth(state.fee, 6, true) + " ETH.";
      out.primary.enabled = true;
      return out;
    }
    out.step = 3;
    out.amountLocked = true;
    if (state.phase === "confirm") {
      out.line = "Send " + amount + " ETH to the relayer on Base?";
      out.detail = "To " + ctx.relayer + ". From " + shortAddress(state.account) + ". Network: Base.";
      out.primary = { label: "Confirm in wallet", action: "send", enabled: true };
      out.secondary = { label: "Go back", action: "back", enabled: true };
      return out;
    }
    if (state.phase === "signing") {
      out.line = "Waiting for your signature.";
      out.detail = "Confirm the transaction in your wallet. Nothing is sent until you do.";
      out.secondary = { label: "Go back", action: "back", enabled: true };
      return out;
    }
    if (state.phase === "sent") {
      out.line = state.slow ? "Still waiting for Base to confirm." : "Sent. Waiting for Base to confirm.";
      out.detail = state.slow ? "It usually takes a few seconds. The link shows where it stands." : "This usually takes a few seconds.";
      out.link = txLink;
      if (state.slow) out.primary = { label: "Check again", action: "check", enabled: true };
      out.secondary = { label: "Start over", action: "restart", enabled: true };
      return out;
    }
    if (state.phase === "confirmed") {
      out.tone = "good";
      out.line = "Confirmed. The relayer has the funds.";
      out.detail = "Refreshing the figures above.";
      out.link = txLink;
      out.primary = { label: "Refresh now", action: "reload", enabled: true };
      return out;
    }
    out.tone = "bad";
    out.amountLocked = false;
    out.step = state.failedTo === "ready" || state.failedTo === "confirm" ? 2 : 1;
    out.line = state.error || "Something went wrong. Nothing was sent.";
    out.link = txLink;
    out.primary = { label: "Try again", action: "retry", enabled: true };
    out.secondary = { label: "Start over", action: "reset", enabled: true };
    return out;
  };

  return {
    BASE_CHAIN_HEX: BASE_CHAIN_HEX,
    parseEth: parseEth,
    formatEth: formatEth,
    estimateFee: estimateFee,
    maxSend: maxSend,
    afford: afford,
    fundsAccounts: fundsAccounts,
    usdText: usdText,
    toHex: toHex,
    fromHex: fromHex,
    shortAddress: shortAddress,
    explain: explain,
    amountHint: amountHint,
    view: view,
  };
}

export type TopupLogic = ReturnType<typeof topupLogic>;
