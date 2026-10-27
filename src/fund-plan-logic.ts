/**
 * Pure logic of the "fund everything short" plan in /ops Funding (otto/mamoru-astro#32): splitting one amount across
 * the wallets of a chain, and the order and wording of a run of transfers.
 *
 * One self-contained factory, like topupLogic(): the console script embeds `fundPlanLogic.toString()` and the tests
 * call the same function. Nothing in here may reference anything outside the function. Amounts are wei as bigint.
 */

export interface PlanRow {
  id: string;
  /** Chain hex, as the wallet reports it. */
  chain: string;
  amount: bigint;
}

export type RowPhase = "waiting" | "switching" | "signing" | "sent" | "confirmed" | "failed" | "skipped";

export function fundPlanLogic() {
  var ZERO = BigInt(0);
  var ONE = BigInt(1);

  /**
   * Splits `total` across wallets in proportion to what each lacks; when none lacks anything, evenly. Every part is
   * floored to `unit` (wei; one micro-unit by default) and what flooring leaves goes to the wallet that lacks most,
   * so the parts always add up to `total` exactly.
   */
  var split = function (total: bigint, shorts: bigint[], unit?: bigint): bigint[] {
    var u = unit && unit > ZERO ? unit : BigInt("1000000000000");
    var n = shorts.length;
    if (!n || total <= ZERO) return shorts.map(function () { return ZERO; });
    var sum = ZERO;
    for (var i = 0; i < n; i++) sum += shorts[i]! > ZERO ? shorts[i]! : ZERO;
    var weights = shorts.map(function (s) { return sum > ZERO ? (s > ZERO ? s : ZERO) : ONE; });
    var wsum = sum > ZERO ? sum : BigInt(n);
    var parts = weights.map(function (w) { return ((total * w) / wsum / u) * u; });
    var used = ZERO;
    var most = 0;
    for (var j = 0; j < n; j++) {
      used += parts[j]!;
      if (weights[j]! > weights[most]!) most = j;
    }
    parts[most] = parts[most]! + (total - used);
    return parts;
  };

  /** Transfers in the order they are sent: grouped by chain so the wallet switches network once per chain. */
  var order = function (rows: PlanRow[]): PlanRow[] {
    var chains: string[] = [];
    for (var i = 0; i < rows.length; i++) if (chains.indexOf(rows[i]!.chain) === -1) chains.push(rows[i]!.chain);
    var out: PlanRow[] = [];
    for (var c = 0; c < chains.length; c++)
      for (var r = 0; r < rows.length; r++) if (rows[r]!.chain === chains[c] && rows[r]!.amount > ZERO) out.push(rows[r]!);
    return out;
  };

  /** How many network switches a run needs, starting from the wallet's chain. */
  var switches = function (rows: PlanRow[], fromChain: string | null): number {
    var at = fromChain ? String(fromChain).toLowerCase() : null;
    var n = 0;
    var o = order(rows);
    for (var i = 0; i < o.length; i++) {
      var c = String(o[i]!.chain).toLowerCase();
      if (c !== at) { n++; at = c; }
    }
    return n;
  };

  var PHASE_WORDS: Record<RowPhase, string> = {
    waiting: "Waiting",
    switching: "Switch network in the wallet",
    signing: "Confirm in the wallet",
    sent: "Sent, waiting for the block",
    confirmed: "Arrived",
    failed: "Not sent",
    skipped: "Skipped",
  };
  var phaseWord = function (p: RowPhase) { return PHASE_WORDS[p] || ""; };

  /** One line for the whole run. */
  var summary = function (phases: RowPhase[]): { text: string; tone: "plain" | "good" | "warn" | "bad"; done: boolean } {
    var n = phases.length, ok = 0, bad = 0, skip = 0, busy = 0;
    for (var i = 0; i < n; i++) {
      var p = phases[i];
      if (p === "confirmed") ok++;
      else if (p === "failed") bad++;
      else if (p === "skipped") skip++;
      else if (p !== "waiting") busy++;
    }
    var done = ok + bad + skip === n;
    if (!n) return { text: "Nothing to send: every amount is zero.", tone: "plain", done: true };
    if (!done) return { text: (busy ? "Sending " + (ok + bad + skip + 1) : "Ready to send") + " of " + n + " transfer" + (n === 1 ? "" : "s") + ".", tone: "plain", done: false };
    if (ok === n) return { text: "All " + n + " transfer" + (n === 1 ? "" : "s") + " arrived.", tone: "good", done: true };
    if (!ok) return { text: "Nothing was sent.", tone: "bad", done: true };
    return { text: ok + " of " + n + " arrived; " + (bad ? bad + " not sent" : "") + (bad && skip ? ", " : "") + (skip ? skip + " skipped" : "") + ".", tone: "warn", done: true };
  };

  return { split: split, order: order, switches: switches, phaseWord: phaseWord, summary: summary };
}
