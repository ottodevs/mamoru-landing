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

  /** "Preguntar al Lab" turn wording (coordinator note: "en cola / pensando"), separate from jobStatusHeadline
   * (the bench's "Ejecutar escenario" wording) so either panel's copy can change without touching the other. */
  var askStatusHeadline = function (status: "queued" | "running"): string {
    return status === "queued" ? "En cola" : "Pensando";
  };
  var askSubText = function (status: "queued" | "running", elapsedSec: number): string {
    if (status !== "queued") return "";
    var base = "El agente lo recoge en unos segundos.";
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

  var ASK_ERROR_WORDS: Record<string, string> = {
    LAB_JOB_TIMEOUT: "se agotó el tiempo del turno",
    LAB_MODEL_UNAVAILABLE: "el modelo no está disponible ahora mismo",
    LAB_JOB_LEASE_LOST: "el runner perdió el turno; vuelve a intentarlo",
    LAB_HOLDOUT_DENIED: "esa ventana es parte de la reserva de prueba y el agente no puede usarla",
    LAB_AGENT_BUDGET: "se alcanzó el límite diario de preguntas al Lab",
    LAB_ANSWER_UNCITED: "la respuesta citaba corridas que no produjo; no se muestra",
    LAB_RUN_MISSING: "el agente citó un resultado que no llegó a guardarse",
    LAB_SERVICE_UNAVAILABLE: "el banco no está disponible ahora mismo",
    LAB_NETWORK: "sin conexión con el servidor",
  };
  /** "Preguntar al Lab" turn-level failure (the job was created, then the runner reported it failed) -- the
   * chat bubble's text, not the inline form error (see askSendErrorText for a request the server never queued). */
  var askFailedText = function (errorCode: string): string {
    return "Falló: " + (ASK_ERROR_WORDS[errorCode] || errorCode || "motivo desconocido");
  };

  /** `POST /ops/lab/api/ask` refusing the request outright (no turn was ever queued): shown near the input,
   * never as a chat bubble -- there is no job id for a bubble to attach to. */
  var askSendErrorText = function (errorCode: string): string {
    if (errorCode === "LAB_JOB_LIMIT_DAILY") return "Has llegado a " + int(MAX_JOBS_PER_DAY) + " preguntas hoy";
    if (errorCode === "LAB_JOB_LIMIT_QUEUED") return "Ya tienes " + int(MAX_QUEUED_JOBS) + " en cola";
    if (errorCode === "LAB_ASK_INVALID") return "Escribe una pregunta de hasta 600 caracteres";
    if (errorCode === "LAB_THREAD_NOT_FOUND") return "Este hilo ya no está disponible";
    if (errorCode === "LAB_CSRF_INVALID") return "La sesión caducó: recarga la página";
    return ASK_ERROR_WORDS[errorCode] || "No se pudo enviar la pregunta";
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

  // ---------------------------------------------------------------------------------------------------------
  // "Preguntar al Lab" (otto/mamoru-astro#30, spec 008 phase 2): rendering the agent's verified answer blocks.
  // esc/metric labels/the verdict sentence wording are a deliberate port of
  // ottodevs/mamoru packages/lab-agent/src/contract.ts (Block types, METRIC_BASE_KEYS, writeVerdictSentence) --
  // this repo cannot import that package (no workspace link), and labLogic() ships zero-import by design, so
  // this is a copy that must be kept in sync by hand, not a shortcut taken for convenience. Nothing here
  // re-verifies a claim or a verdict's comparability: AL-21/AL-20c already happened on the runner before this
  // job's answer_json was ever written, so every block this function is given is trusted, not re-checked.
  // ---------------------------------------------------------------------------------------------------------

  var escHtml = function (s: unknown): string {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;";
    });
  };

  var MAX_QUESTION_CHARS = 600;
  /** Client-side mirror of lab-spec.ts's validateQuestion bounds, for disabling "Enviar" before the round trip. */
  var questionValid = function (q: string): boolean {
    var t = (q || "").trim();
    return t.length >= 1 && t.length <= MAX_QUESTION_CHARS;
  };

  /** Three questions phrased from the window currently in view (coordinator note), never a number: the agent
   * fills in the actual figures once it runs. */
  var suggestionQuestions = function (windowLabel: string): string[] {
    return [
      "¿Qué habría pasado con 1.000 USDC en " + windowLabel + "?",
      "¿Y con el rango el doble de ancho en " + windowLabel + "?",
      "Compara la política actual con la guarda de caídas en " + windowLabel + ".",
    ];
  };

  var METRIC_LABEL_ES: Record<string, string> = {
    end: "Saldo final",
    net: "Resultado neto",
    vsHodl: "Vs. mantener la mezcla",
    vsUsdc: "Vs. quedarte en USDC",
    fees: "Comisiones ganadas",
    gas: "Gas gastado",
    priceMove: "Movimiento de precio (BTC)",
    timeInRange: "Tiempo en rango",
    maxDrawdown: "Caída máxima",
    return: "Retorno",
    days: "Días",
  };
  /** `metric` is the closed enum AL-20a defines, plus `operations.<kind>` for whatever kind a run counted. */
  var metricLabel = function (metric: string): string {
    if (METRIC_LABEL_ES[metric]) return METRIC_LABEL_ES[metric];
    if (metric.indexOf("operations.") === 0) return "Operaciones: " + metric.slice("operations.".length);
    return metric;
  };

  var MONEY_SIGNED_METRICS: Record<string, boolean> = { net: true, vsHodl: true, vsUsdc: true };
  var PCT_SIGNED_METRICS: Record<string, boolean> = { priceMove: true, return: true };
  /** AL-21: the screen always shows the stored (already display-rounded) value, formatted per the metric's
   * unit -- USDC deltas signed, absolute USDC magnitudes plain, signed percentages, maxDrawdown as a forced
   * negative (same convention the bench's own Diagnóstico tab uses), counts and days as plain integers. */
  var fmtClaimValue = function (value: number, metric: string): string {
    if (MONEY_SIGNED_METRICS[metric]) return sg(value) + " USDC";
    if (metric === "end" || metric === "fees" || metric === "gas") return money(value) + " USDC";
    if (PCT_SIGNED_METRICS[metric]) return pct(value / 100, 1);
    if (metric === "maxDrawdown") return "−" + nf(1).format(Math.abs(value)) + " %";
    if (metric === "timeInRange") return nf(1).format(value) + " %";
    if (metric === "days") return int(value) + (value === 1 ? " día" : " días");
    if (metric.indexOf("operations.") === 0) return int(value) + (value === 1 ? " operación" : " operaciones");
    return String(value);
  };

  type VerdictRunLike = { metrics: { end: number; vsHodl: number }; deposit: number; variantLabel: string };
  var verdictDirectionWord = function (delta: number): "arriba" | "abajo" | "igual" {
    if (Math.abs(delta) <= 0.01) return "igual";
    return delta > 0 ? "arriba" : "abajo";
  };
  var isVerdictBaseline = function (x: string): boolean {
    return x === "hold" || x === "usdc";
  };
  /** AL-20b: the verdict sentence, word for word the same templates as writeVerdictSentence (contract.ts) --
   * comparability (AL-20c) is not re-checked here, it already gated whether this block exists at all. */
  var verdictSentence = function (run: VerdictRunLike, against: string, other?: VerdictRunLike): string {
    if (against === "hold") {
      var delta = run.metrics.vsHodl;
      var dir = verdictDirectionWord(delta);
      if (dir === "igual") return "Terminó igual que mantener la mezcla (diferencia menor a 0.01 USDC).";
      return "Terminó " + money(Math.abs(delta)) + " USDC por " + (dir === "arriba" ? "encima de" : "debajo de") + " mantener la mezcla (hold).";
    }
    if (against === "usdc") {
      var delta2 = run.metrics.end - run.deposit;
      var dir2 = verdictDirectionWord(delta2);
      if (dir2 === "igual") return "Terminó igual que quedarte en USDC (diferencia menor a 0.01 USDC).";
      return "Terminó " + money(Math.abs(delta2)) + " USDC por " + (dir2 === "arriba" ? "encima de" : "debajo de") + " quedarte en USDC.";
    }
    if (!other) return "No se pudo mostrar esta comparación: falta el otro resultado.";
    var delta3 = run.metrics.end - other.metrics.end;
    var dir3 = verdictDirectionWord(delta3);
    if (dir3 === "igual") return "Terminó igual que " + other.variantLabel + " (diferencia menor a 0.01 USDC).";
    return "Terminó " + money(Math.abs(delta3)) + " USDC por " + (dir3 === "arriba" ? "encima de" : "debajo de") + " " + other.variantLabel + ".";
  };

  type AnswerBlock =
    | { type: "text"; md: string }
    | { type: "claim"; metric: string; runId: string; value: number }
    | { type: "verdict"; runId: string; against: string }
    | { type: "chart"; kind: string; runIds: string[]; pool?: string }
    | { type: "caveat"; md: string };

  /** AL-21a: the answer's headline is always the first verdict, or with none the first claim -- never a text
   * block, never a chart. `null` for an answer with neither (a refusal/caveat-only answer, AL-22, is valid). */
  var answerHeadlineBlock = function (blocks: AnswerBlock[]): AnswerBlock | null {
    for (var i = 0; i < blocks.length; i++) if (blocks[i].type === "verdict") return blocks[i];
    for (var j = 0; j < blocks.length; j++) if (blocks[j].type === "claim") return blocks[j];
    return null;
  };

  /** AL-20: text/caveat prose references a claim as `{{c0}}` and a verdict as `{{v0}}` -- the screen already
   * shows that figure as a chip or sentence above, so the token is dropped rather than resolved a second time. */
  var stripRefTokens = function (md: string): string {
    return md.replace(/\{\{[cv]\d+\}\}/g, "").replace(/\s{2,}/g, " ").trim();
  };

  type RunLite = VerdictRunLike & { resultHash: string; windowId: string };

  var claimChipHtml = function (b: { runId: string; value: number; metric: string }, run?: RunLite): string {
    var title = run ? "Resultado: " + run.variantLabel : "";
    return (
      '<span class="lab-ask-chip" data-run-id="' + escHtml(b.runId) + '"' + (title ? ' title="' + escHtml(title) + '"' : "") + ">" +
      "<b>" + escHtml(fmtClaimValue(b.value, b.metric)) + "</b><small>" + escHtml(metricLabel(b.metric)) + "</small></span>"
    );
  };

  var verdictText = function (b: { runId: string; against: string }, runsByHash: Record<string, RunLite>): string {
    var run = runsByHash[b.runId];
    if (!run) return "No se pudo mostrar esta comparación: falta el resultado.";
    var other = isVerdictBaseline(b.against) ? undefined : runsByHash[b.against];
    return verdictSentence(run, b.against, other);
  };

  var chartButtonHtml = function (b: { kind: string; runIds: string[] }, runsByHash: Record<string, RunLite>): string {
    var first = b.runIds[0];
    var run = first ? runsByHash[first] : undefined;
    var windowId = run ? run.windowId : "";
    var compare = b.runIds.length > 1 || b.kind === "decomposition" ? "1" : "0";
    return (
      '<button type="button" class="lab-ask-openbench" data-run-id="' + escHtml(first || "") + '" data-window-id="' + escHtml(windowId) + '" data-compare="' + compare + '">' +
      "Ver en el banco</button>"
    );
  };

  /**
   * AL-21a/AL-22: the full answer as HTML -- headline (verdict sentence or claim chip) first, then every other
   * claim as a chip, every other verdict as a sentence, every chart as an "open in the bench" button, and all
   * prose (text/caveat) together under the "not verified" label, never mixed with the verified blocks above
   * it. `partial` renders the AL-22 notice when the answer was flagged `LAB_ANSWER_PARTIAL` (verified claims
   * and charts only, after a failed repair). An answer with no blocks (should not happen; AL-20 requires at
   * least one) renders nothing rather than an empty shell.
   */
  var answerBlocksHtml = function (blocks: AnswerBlock[], runsByHash: Record<string, RunLite>, partial: boolean): string {
    if (!blocks || !blocks.length) return "";
    var headline = answerHeadlineBlock(blocks);
    var out = "";
    if (headline) {
      // `.lab-verdict`/`.lab-prose` are the PoC-1 prototype's own class names (AL-53: "the visual reference
      // for the implementing session"), ported into lab-style.ts at the B-07 shell pass and left unused until
      // this ticket -- reused here rather than inventing a parallel set of class names for the same thing.
      out += headline.type === "verdict"
        ? '<p class="lab-verdict">' + escHtml(verdictText(headline, runsByHash)) + "</p>"
        : '<div class="lab-verdict lab-verdict-claim">' + claimChipHtml(headline, runsByHash[(headline as { runId: string }).runId]) + "</div>";
    }
    if (partial) out += '<p class="lab-ask-partial">Respuesta parcial: solo se muestra lo verificado.</p>';
    var chips = "";
    var sentences = "";
    var charts = "";
    var prose = "";
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      if (b === headline) continue;
      if (b.type === "claim") chips += claimChipHtml(b, runsByHash[b.runId]);
      else if (b.type === "verdict") sentences += '<p class="lab-verdict">' + escHtml(verdictText(b, runsByHash)) + "</p>";
      else if (b.type === "chart") charts += chartButtonHtml(b, runsByHash);
      else prose += "<p>" + escHtml(stripRefTokens(b.md)) + "</p>";
    }
    if (chips) out += '<div class="lab-ask-chips">' + chips + "</div>";
    out += sentences + charts;
    if (prose) out += '<div class="lab-prose"><div class="lab-prose-label">Explicación del agente · no verificada</div>' + prose + "</div>";
    return out;
  };

  type CostMeterLite = { modelCalls: { model: string; promptTokens: number; completionTokens: number }[]; runs: unknown[]; wallMs: number };
  /** The small mono footer under an answer: model(s), tokens in→out, runs, seconds, and the shadow cost when
   * the server could price it (lab_prices configured) -- omitted, not shown as 0, when it could not. */
  var answerFooterText = function (cost: CostMeterLite | null, shadowUsd: number | null): string {
    if (!cost) return "";
    var models: string[] = [];
    var seen: Record<string, boolean> = {};
    for (var i = 0; i < cost.modelCalls.length; i++) {
      var m = cost.modelCalls[i].model;
      if (!seen[m]) {
        seen[m] = true;
        models.push(m);
      }
    }
    var tokensIn = 0;
    var tokensOut = 0;
    for (var j = 0; j < cost.modelCalls.length; j++) {
      tokensIn += cost.modelCalls[j].promptTokens || 0;
      tokensOut += cost.modelCalls[j].completionTokens || 0;
    }
    var parts: string[] = [];
    if (models.length) parts.push(models.join(" · "));
    parts.push(int(tokensIn) + "→" + int(tokensOut) + " tok");
    parts.push(cost.runs.length + (cost.runs.length === 1 ? " run" : " runs"));
    parts.push((cost.wallMs / 1000).toFixed(1) + " s");
    if (shadowUsd !== null && shadowUsd !== undefined) parts.push("$" + shadowUsd.toFixed(4) + " sombra");
    return parts.join(" · ");
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
    escHtml: escHtml,
    MAX_QUESTION_CHARS: MAX_QUESTION_CHARS,
    questionValid: questionValid,
    suggestionQuestions: suggestionQuestions,
    metricLabel: metricLabel,
    fmtClaimValue: fmtClaimValue,
    verdictSentence: verdictSentence,
    isVerdictBaseline: isVerdictBaseline,
    answerHeadlineBlock: answerHeadlineBlock,
    stripRefTokens: stripRefTokens,
    answerBlocksHtml: answerBlocksHtml,
    answerFooterText: answerFooterText,
    askStatusHeadline: askStatusHeadline,
    askSubText: askSubText,
    askFailedText: askFailedText,
    askSendErrorText: askSendErrorText,
  };
}

export type LabLogic = ReturnType<typeof labLogic>;
