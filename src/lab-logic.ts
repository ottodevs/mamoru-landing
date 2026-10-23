/**
 * otto/mamoru-astro#28: pure client-side logic for `/ops/lab`, in the self-contained-factory shape the rest of
 * the console uses (ops-router-logic.ts's `opsRouterLogic()`, topup-logic.ts's `topupLogic()`): one function,
 * zero imports, so `labLogic.toString()` can be embedded into the shipped script (ops-client.ts) and the exact
 * same function is what the tests import and call. Chart drawing and DOM wiring stay in ops-client.ts, same as
 * the Topup widget; this file holds only what is worth unit-testing apart from a DOM.
 */

export function labLogic() {
  var WIDTH_MIN = 500;
  var WIDTH_MAX = 8000;
  var WIDTH_STEP = 500;
  var DEPOSIT_MIN = 100;
  var DEPOSIT_MAX = 10000;

  /** `${windowId}|${base}|${widthTicks}|${deposit}` — must agree with lab-spec.ts's specKey(). */
  var specKey = function (spec: { windowId: string; base: string; widthTicks: number; deposit: number }): string {
    return spec.windowId + "|" + spec.base + "|" + spec.widthTicks + "|" + spec.deposit;
  };

  /** Client-side mirror of lab-spec.ts's bounds (B-01), for disabling "Ejecutar escenario" before the round trip. */
  var validSpec = function (spec: { windowId: string; base: string; widthTicks: number; deposit: number }): boolean {
    if (!spec.windowId) return false;
    if (spec.base !== "live" && spec.base !== "guard") return false;
    if (!(spec.widthTicks >= WIDTH_MIN && spec.widthTicks <= WIDTH_MAX && spec.widthTicks % WIDTH_STEP === 0)) return false;
    if (!(Number.isInteger(spec.deposit) && spec.deposit >= DEPOSIT_MIN && spec.deposit <= DEPOSIT_MAX)) return false;
    return true;
  };

  /** "Nice" axis tick values spanning [min, max], at most `n` of them. Direct port of the prototype's `ticks()`. */
  var ticks = function (min: number, max: number, n: number): number[] {
    var span = max - min || 1;
    var s0 = span / n;
    var mag = Math.pow(10, Math.floor(Math.log10(s0)));
    var candidates = [1, 2, 2.5, 5, 10].map(function (m) { return m * mag; });
    var step = candidates.find(function (s) { return span / s <= n; }) || mag * 10;
    var out: number[] = [];
    for (var v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(10));
    return out;
  };

  var nf = function (d: number) {
    return new Intl.NumberFormat("es-ES", { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: "always" });
  };
  var money = function (v: number): string {
    return nf(2).format(v);
  };
  /** Grouped whole number: "2.000", "10.000" — ticks, USDC bounds, axis labels, anywhere a plain number would read wrong. */
  var int = function (v: number): string {
    return nf(0).format(v);
  };
  /** Signed money, with a dead zone under 0.004 so rounding noise does not flip the sign shown. */
  var sg = function (v: number): string {
    return (v > 0.004 ? "+" : v < -0.004 ? "−" : "") + money(Math.abs(v));
  };
  var pct = function (x: number, d?: number): string {
    var digits = d === undefined ? 1 : d;
    return (x > 0 ? "+" : x < 0 ? "−" : "") + nf(digits).format(Math.abs(x * 100)) + " %";
  };
  var cls = function (v: number): string {
    return v > 0.004 ? "lab-pos" : v < -0.004 ? "lab-neg" : "";
  };

  type SeriesPoint = { t: number };
  var idxAt = function (series: SeriesPoint[], t: number): number {
    var i = 0;
    while (i < series.length - 1 && series[i + 1].t <= t) i++;
    return i;
  };
  var nearestIndex = function (series: SeriesPoint[], t: number): number {
    var best = 0;
    for (var k = 1; k < series.length; k++) {
      if (Math.abs(series[k].t - t) < Math.abs(series[best].t - t)) best = k;
    }
    return best;
  };

  type Op = { t: number; kind: string };
  /** Re-range, harvest, enter — the operations the price chart marks and the event list shows (hides swaps). */
  var keyOps = function (ops: Op[]): Op[] {
    return ops.filter(function (o) { return o.kind === "rerange" || o.kind === "harvest" || o.kind === "enter_mint"; });
  };

  /** B-09: a verdict sentence between two runs is only ever shown when they share window, deposit and simVersion. */
  var canCompareToBaseline = function (
    run: { spec: { windowId: string }; deposit: number; simVersion: string },
    baseline: { spec: { windowId: string }; deposit: number; simVersion: string } | null,
  ): boolean {
    if (!baseline) return false;
    return run.spec.windowId === baseline.spec.windowId && run.deposit === baseline.deposit && run.simVersion === baseline.simVersion;
  };

  // base/widthTicks live under `run.spec` (the B-02 RunResult shape the screen API actually returns), not at
  // the top level — reading `run.base`/`run.widthTicks` directly made every strategy collapse into the same
  // "undefined|undefined" row (GPT-6 Sol review, otto/mamoru-astro#28).
  type CompareRun = { spec: { base: string; widthTicks: number }; deposit: number; variantLabel: string; metrics: { vsHodl: number } };
  type CompareWindow = { windowId: string; label: string; runs: CompareRun[] };
  type CompareRow = { base: string; widthTicks: number; variantLabel: string; byWindow: Record<string, number | null> };
  /** B-07 Compare tab: strategies (by base+width, deposit 1000) as rows, windows as columns, vsHodl per cell. */
  var compareMatrix = function (windows: CompareWindow[]): CompareRow[] {
    var rows: CompareRow[] = [];
    var seen: Record<string, number> = {};
    for (var w = 0; w < windows.length; w++) {
      var runs = windows[w].runs.filter(function (r) { return r.deposit === 1000; });
      for (var r = 0; r < runs.length; r++) {
        var run = runs[r];
        var key = run.spec.base + "|" + run.spec.widthTicks;
        var idx = seen[key];
        if (idx === undefined) {
          idx = rows.length;
          seen[key] = idx;
          rows.push({ base: run.spec.base, widthTicks: run.spec.widthTicks, variantLabel: run.variantLabel, byWindow: {} });
        }
        rows[idx].byWindow[windows[w].windowId] = run.metrics.vsHodl;
      }
    }
    return rows;
  };

  /** Polling backoff for a queued/running job (B-08): quick at first, settling at 3s, capped so a slow runner is still noticed. */
  var pollDelayMs = function (attempt: number): number {
    if (attempt <= 0) return 600;
    if (attempt === 1) return 1200;
    return 3000;
  };

  // ---- window labels (coordinator note): the manifest's window.label is long English prose ("Feb 2025, 2-3
  // Feb tariff headline crash (ETH -25%)") and overflows the top segment at 390px. A short Spanish label built
  // from regime + month of window.from is what the segment buttons, Probar's window field and the strategy
  // list show; the long label survives as a title tooltip and in Supuestos. ----

  var REGIME_WORD: Record<string, string> = { crash: "Caída", rally: "Subida", calm: "Calma", "stable-stress": "Estrés USDT" };
  var MONTH_SHORT = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  var MONTH_LONG = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
  /** "Caída feb 2025" — short month, no dot, 4-digit year. Segment buttons, Probar, strategy assumptions. */
  // The month is taken from the middle of the window: feb2025 starts on 29 Jan but is the February crash.
  var windowMid = function (fromIso: string, toIso?: string): Date {
    var a = new Date(fromIso).getTime();
    return new Date(toIso ? (a + new Date(toIso).getTime()) / 2 : a);
  };
  var windowShortLabel = function (regime: string, fromIso: string, toIso?: string): string {
    var d = windowMid(fromIso, toIso);
    return (REGIME_WORD[regime] || regime) + " " + MONTH_SHORT[d.getUTCMonth()] + " " + d.getUTCFullYear();
  };
  /** "Caída de febrero 2025" — long month, for the headline sentence only. */
  var windowHeadlineLabel = function (regime: string, fromIso: string, toIso?: string): string {
    var d = windowMid(fromIso, toIso);
    return (REGIME_WORD[regime] || regime) + " de " + MONTH_LONG[d.getUTCMonth()] + " " + d.getUTCFullYear();
  };

  /** Strategy card subtitle: a plain sentence instead of the raw policyId (kept in Supuestos). */
  var strategyNote = function (base: string, widthTicks: number): string {
    var widthPart = "rango de " + int(widthTicks) + " ticks";
    if (base === "guard") {
      return widthTicks === 2000 ? "Congela entradas si el precio cae fuerte" : "Congela entradas si el precio cae fuerte, " + widthPart;
    }
    return widthTicks === 2000 ? "Lo que corre hoy en producción" : "Mismo motor, " + widthPart;
  };

  /** Like the prototype's own bootstrap: the sample where the strategy trails holding the mix the most. */
  var initialCursorIndex = function (series: { v: number; h: number }[]): number {
    var idx = 0;
    for (var k = 1; k < series.length; k++) {
      if (series[k].v - series[k].h < series[idx].v - series[idx].h) idx = k;
    }
    return idx;
  };

  // ---- "Ejecutar escenario" feedback (otto/mamoru-astro#28 follow-up, Ot 23 Oct: a click that resolved
  // instantly — the spec already existed — left the button re-enabled and nothing else on screen said
  // anything). Every piece of text the status card and the chip show is a pure function of a few known values,
  // so the message choice (including "this was already computed") is unit-tested the same way the client ships
  // it, not eyeballed in a screenshot. ----

  var MAX_JOBS_PER_DAY = 20;
  var MAX_QUEUED_JOBS = 3;
  var BASE_LABEL: Record<string, string> = { live: "Política actual", guard: "Con guarda de caídas" };

  /** "Caída feb 2025 · Política actual · 2.000 ticks · 1.000 USDC" — the requested spec, always visible on the card. */
  var specWords = function (windowLabel: string, base: string, widthTicks: number, deposit: number): string {
    return windowLabel + " · " + (BASE_LABEL[base] || base) + " · " + int(widthTicks) + " ticks · " + int(deposit) + " USDC";
  };

  type JobStatusInput = { status: "queued" | "running" | "done"; elapsedSec: number; variantLabel: string; windowLabel: string; alreadyExisted: boolean };
  /** The status card's headline for queued/running/done. Never called for `failed` — see jobFailedText. */
  var jobStatusText = function (input: JobStatusInput): string {
    if (input.status === "queued") return "En cola · " + input.elapsedSec + " s";
    if (input.status === "running") return "Calculando con el motor de producción · " + input.elapsedSec + " s";
    if (input.alreadyExisted) return "Ya estaba calculado: «" + input.variantLabel + "» en " + input.windowLabel + ". Te lo he seleccionado.";
    return "Listo en " + input.elapsedSec + " s: «" + input.variantLabel + "» añadida a " + input.windowLabel + ".";
  };

  /**
   * The queued/running headline with no number in it (GPT-6 Sol review, otto/mamoru-astro#28 follow-up): the
   * live region's announced text must change only on a real state change, never once a second just because the
   * elapsed counter ticked — the number renders separately, in an aria-hidden span jobStatusText's full string
   * is still right for (the chip, which is aria-hidden entirely, and the frozen one-time "done" text above).
   */
  var jobStatusHeadline = function (status: "queued" | "running"): string {
    return status === "queued" ? "En cola" : "Calculando con el motor de producción";
  };

  /** The queued sub-line, with the "still polling" notice appended past 60 s (running has no sub-line). */
  var jobSubText = function (status: "queued" | "running" | "done", elapsedSec: number): string {
    if (status !== "queued") return "";
    var base = "El runner de lady lo recoge en unos segundos.";
    return elapsedSec > 60 ? base + " El runner no ha respondido todavía." : base;
  };

  var JOB_ERROR_WORDS: Record<string, string> = {
    LAB_JOB_LEASE_LOST: "el runner perdió el trabajo; vuelve a intentarlo",
    LAB_SPEC_INVALID: "el escenario pedido no es válido",
    LAB_DATASET_MISSING: "esta ventana no tiene datos para esa base",
    LAB_JOB_TIMEOUT: "se agotó el tiempo del trabajo",
    LAB_RUN_INVALID: "el runner devolvió un resultado con forma inválida",
    LAB_RUN_WRITE_FAILED: "no se pudo guardar el resultado; vuelve a intentarlo",
    LAB_HOLDOUT_DENIED: "esa ventana es parte de la reserva de prueba y no se puede correr aquí",
    LAB_SERVICE_UNAVAILABLE: "el banco no está disponible ahora mismo",
    LAB_NETWORK: "sin conexión con el servidor",
    LAB_CSRF_INVALID: "la sesión caducó: recarga la página",
  };
  /** The daily/queued limits get their own sentence with the actual numbers; everything else is "Falló: <word>". */
  var jobFailedText = function (errorCode: string): string {
    if (errorCode === "LAB_JOB_LIMIT_DAILY") return "Has llegado a " + int(MAX_JOBS_PER_DAY) + " escenarios hoy";
    if (errorCode === "LAB_JOB_LIMIT_QUEUED") return "Ya tienes " + int(MAX_QUEUED_JOBS) + " en cola";
    return "Falló: " + (JOB_ERROR_WORDS[errorCode] || errorCode || "motivo desconocido");
  };

  /**
   * The stale-completion guard (GPT-6 Sol review, otto/mamoru-astro#28 follow-up): a job's POST response, each
   * poll, and the final runs-refresh are all tagged with the generation counter active when runScenario()
   * started that attempt. Every one of those async steps calls this before writing anything to shared state —
   * a completion for an older attempt that resolves after a newer one has already started is dropped outright,
   * regardless of network arrival order, so it can never overwrite a newer run's selection or window. The rest
   * of this orchestration (runScenario/pollJob/onJobDone in ops-client.ts) is DOM-coupled and has no test
   * harness to drive it end to end; this predicate is the one piece of that guard pure enough to unit-test
   * directly, and ops-client.ts calls this exact function rather than repeating the comparison inline.
   */
  var isCurrentJobGen = function (eventGen: number, liveGen: number): boolean {
    return eventGen === liveGen;
  };

  return {
    WIDTH_MIN: WIDTH_MIN,
    WIDTH_MAX: WIDTH_MAX,
    WIDTH_STEP: WIDTH_STEP,
    DEPOSIT_MIN: DEPOSIT_MIN,
    DEPOSIT_MAX: DEPOSIT_MAX,
    specKey: specKey,
    validSpec: validSpec,
    ticks: ticks,
    money: money,
    int: int,
    sg: sg,
    pct: pct,
    cls: cls,
    idxAt: idxAt,
    nearestIndex: nearestIndex,
    keyOps: keyOps,
    canCompareToBaseline: canCompareToBaseline,
    compareMatrix: compareMatrix,
    pollDelayMs: pollDelayMs,
    windowShortLabel: windowShortLabel,
    windowHeadlineLabel: windowHeadlineLabel,
    strategyNote: strategyNote,
    initialCursorIndex: initialCursorIndex,
    MAX_JOBS_PER_DAY: MAX_JOBS_PER_DAY,
    MAX_QUEUED_JOBS: MAX_QUEUED_JOBS,
    specWords: specWords,
    jobStatusText: jobStatusText,
    jobStatusHeadline: jobStatusHeadline,
    jobSubText: jobSubText,
    jobFailedText: jobFailedText,
    isCurrentJobGen: isCurrentJobGen,
  };
}

export type LabLogic = ReturnType<typeof labLogic>;
