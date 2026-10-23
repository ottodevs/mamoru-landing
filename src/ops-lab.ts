/**
 * otto/mamoru-astro#28 (spec 008 phase 1): `/ops/lab` — the bench screen shell (B-07) and the screen API
 * handlers behind the `/ops` session (B-06). The shell is a static skeleton close to the approved prototype
 * (lab2.html); every number in it comes from the client fetching this file's API at runtime (unlike the
 * prototype, which had its data baked in at build time), so the server here never computes a verdict, a chart
 * point or a strategy ranking — it only reads `lab_runs`/`lab_jobs` rows written by the runner (Constitution VII).
 */

import type { D1Db } from "./d1-infra";
import {
  LAB_DATASET_MISSING,
  LAB_SPEC_INVALID,
  MAX_JOBS_PER_DAY,
  MAX_QUEUED_JOBS,
  specKey,
  validateSpec,
  validateQuestion,
  threadTitleFromQuestion,
} from "./lab-spec";
import {
  activeJobBySpecKey,
  agentJobsByThread,
  countJobsToday,
  findRunBySpecKey,
  hasWindow,
  insertDoneJobIfUnderLimit,
  insertQueuedAgentJobIfEligible,
  insertQueuedJobIfEligible,
  insertThread,
  jobById,
  loadShadowPriceTable,
  readCatalog,
  runByHash,
  runSummariesForWindow,
  runSummaryByHash,
  shadowCostUsd,
  threadById,
  threadsByOwner,
  touchThread,
  windowHasBase,
  type AgentJobRow,
} from "./lab-store";
import { esc } from "./text";
import type { SectionView } from "./ops";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

// ---- the bench shell (B-07, B-11): a static skeleton, filled by the client from the API below ----

function labShell(csrf: string): string {
  return `<div class="lab-root" id="lab-root" data-lab-csrf="${esc(csrf)}">
  <header class="lab-top">
    <div class="lab-brand">Mamoru <span>· Lab</span></div>
    <div class="lab-seg" id="lab-windows" role="group" aria-label="Ventana histórica"></div>
    <div class="lab-simchip">Simulación sobre historia real de Base · no son fondos</div>
  </header>
  <div class="lab-shell">
    <aside class="lab-left" aria-label="Experimento">
      <section class="lab-cap" id="lab-cap"></section>
      <section style="display:grid;gap:8px">
        <div class="lab-k">Estrategias del experimento</div>
        <div class="lab-variants" id="lab-variants"></div>
        <!-- Purely visual (otto/mamoru-astro#28 follow-up, GPT-6 Sol review): the right-column status card is
             the one announced live region; a second aria-live here would double-announce the same ticking text. -->
        <div class="lab-chip-job" id="lab-job-chip" aria-hidden="true" hidden></div>
      </section>
      <details class="lab-box" id="lab-assum"><summary class="lab-k">Supuestos</summary><dl class="lab-ass" id="lab-ass" style="margin-top:10px"></dl></details>
    </aside>

    <main>
      <div class="lab-benchhead">
        <h2 id="lab-headline" style="margin:0;font-size:1.35rem;font-weight:400"></h2>
      </div>
      <div class="lab-tiles" id="lab-tiles"></div>

      <section style="display:grid;gap:8px">
        <div class="lab-charthead">
          <h2>Precio y rango donde trabaja tu dinero</h2>
          <div class="lab-pooltabs" id="lab-pooltabs" role="group" aria-label="Pool"></div>
        </div>
        <div class="lab-legend"><span><i style="border-color:var(--ink)"></i>precio</span><span><i style="border-color:var(--bandedge);border-top-width:8px"></i>rango activo</span><span class="lab-ghostleg"><i style="border-color:var(--ghost);border-top-style:dashed"></i>rango de la política actual</span><span>▲ recentra · ● cobra · ◆ entra</span></div>
        <div class="lab-chart" id="lab-price"></div>
      </section>

      <section style="display:grid;gap:8px">
        <div class="lab-charthead"><h2>Tu dinero</h2></div>
        <div class="lab-legend"><span><i style="border-color:var(--mamoru)"></i>esta estrategia</span><span class="lab-ghostleg"><i style="border-color:var(--ghost);border-top-style:dashed"></i>política actual</span><span><i style="border-color:var(--hold)"></i>mantener la mezcla</span><span><i style="border-color:var(--usdc);border-top-style:dotted"></i>quedarse en USDC</span></div>
        <div class="lab-chart" id="lab-money"></div>
      </section>

      <div class="lab-narr" id="lab-narr" aria-live="polite"></div>

      <div class="lab-transport">
        <button type="button" class="lab-ctl lab-play" id="lab-play">Reproducir</button>
        <button type="button" class="lab-ctl" id="lab-prev" aria-label="Evento anterior">◂ evento</button>
        <button type="button" class="lab-ctl" id="lab-next" aria-label="Evento siguiente">evento ▸</button>
        <button type="button" class="lab-ctl" id="lab-speed">1×</button>
        <div class="lab-track"><div class="lab-ticks" id="lab-ticks" aria-hidden="true"></div><input type="range" id="lab-scrub" min="0" value="0" aria-label="Momento" /></div>
      </div>

      <section>
        <div class="lab-tabs" role="tablist">
          <button type="button" class="lab-tab" role="tab" aria-selected="true" data-lab-t="ev">Eventos</button>
          <button type="button" class="lab-tab" role="tab" aria-selected="false" data-lab-t="cmp">Comparar</button>
          <button type="button" class="lab-tab" role="tab" aria-selected="false" data-lab-t="dg">Diagnóstico</button>
        </div>
        <div id="lab-t-ev" style="padding-top:8px"></div>
        <div id="lab-t-cmp" style="padding-top:12px" hidden></div>
        <div id="lab-t-dg" style="padding-top:12px" hidden></div>
      </section>
    </main>

    <aside class="lab-right" aria-label="Probar y preguntar">
      <div class="lab-rtabs" role="tablist">
        <button type="button" role="tab" aria-selected="true" data-lab-r="probar">Probar</button>
        <button type="button" role="tab" aria-selected="false" data-lab-r="preguntar">Preguntar al Lab</button>
      </div>
      <section id="lab-r-probar" style="display:grid;gap:16px"></section>
      <!-- otto/mamoru-astro#30 (spec 008 phase 2, AL-50..53): a static skeleton, same discipline as the Probar
           panel above -- every thread, message and answer comes from the screen API at runtime, this Worker
           never computes a verdict, a claim's value or an answer's shape. -->
      <section id="lab-r-preguntar" class="lab-chat" hidden aria-label="Preguntar al Lab">
        <div class="lab-ask-head">
          <select id="lab-ask-thread" class="lab-ask-threadsel" aria-label="Hilo"></select>
          <button type="button" id="lab-ask-new" class="lab-ask-new">Nuevo hilo</button>
        </div>
        <div class="lab-ask-messages" id="lab-ask-messages"></div>
        <div class="lab-ask-suggestions" id="lab-ask-suggestions"></div>
        <p class="lab-ask-err" id="lab-ask-err" role="alert"></p>
        <form class="lab-ask-form" id="lab-ask-form">
          <textarea id="lab-ask-input" class="lab-ask-input" maxlength="600" rows="1" placeholder="Pregunta algo sobre el banco…" aria-label="Pregunta para el Lab"></textarea>
          <button type="submit" id="lab-ask-send" class="lab-ask-send">Enviar</button>
        </form>
      </section>
    </aside>
  </div>
  <p class="empty" id="lab-empty" hidden>Todavía no hay runs sembrados en el banco para mostrar.</p>
  <noscript><p class="empty">El banco necesita JavaScript: carga los datos desde la API de pantalla.</p></noscript>
</div>`;
}

export function labSection(csrf: string): SectionView {
  return { section: "lab", title: "Lab", html: `<h1 class="sr-only">Lab</h1>${labShell(csrf)}` };
}

// ---- screen API (B-06), behind the /ops session; CSRF checked by the caller on the POST route ----

export async function handleLabCatalog(db: D1Db | undefined): Promise<Response> {
  if (!db) return json({ windows: [] });
  return json({ windows: await readCatalog(db) });
}

export async function handleLabRuns(db: D1Db | undefined, windowId: string | null): Promise<Response> {
  if (!windowId) return json({ error: LAB_SPEC_INVALID }, 400);
  if (!db) return json({ runs: [] });
  return json({ runs: await runSummariesForWindow(db, windowId) });
}

export async function handleLabRun(db: D1Db | undefined, hash: string): Promise<Response> {
  if (!db) return json({ error: "LAB_RUN_NOT_FOUND" }, 404);
  const run = await runByHash(db, hash);
  if (!run) return json({ error: "LAB_RUN_NOT_FOUND" }, 404);
  return json({ run });
}

export async function handleLabJobStatus(db: D1Db | undefined, id: string): Promise<Response> {
  if (!db) return json({ error: "LAB_JOB_NOT_FOUND" }, 404);
  const job = await jobById(db, id);
  if (!job) return json({ error: "LAB_JOB_NOT_FOUND" }, 404);
  return json({ job: { id: job.id, status: job.status, resultHash: job.resultHash, errorCode: job.errorCode, spec: job.spec } });
}

/**
 * B-04: daily limit applies on every request (including a dedupe-to-finished-run hit, since it is still
 * usage); the queued-slot limit only when a new `queued` row would actually be inserted — a dedupe never
 * occupies a slot. Every write here is one conditional `INSERT ... SELECT ... WHERE` statement (GPT-6 Sol
 * review, otto/mamoru-astro#28): a separate read-then-insert would let two concurrent requests both pass the
 * count check and both insert, overshooting the limits, and would miss a spec whose job is already queued or
 * running (not yet a finished run) — the dedupe must cover in-flight work too, or two requests for the exact
 * same spec queue the work twice.
 */
export async function handleLabCreateJob(db: D1Db | undefined, requester: string, input: unknown): Promise<Response> {
  if (!db) return json({ error: "LAB_SERVICE_UNAVAILABLE" }, 503);
  const check = validateSpec(input);
  if (!check.ok) return json({ error: check.error }, 400);
  const { spec } = check;
  if (!(await hasWindow(db, spec.windowId))) return json({ error: LAB_SPEC_INVALID }, 400);
  if (!(await windowHasBase(db, spec.windowId, spec.base))) return json({ error: LAB_DATASET_MISSING }, 400);

  const key = specKey(spec);
  const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const nowIso = new Date().toISOString();
  const existing = await findRunBySpecKey(db, key);

  if (existing) {
    const id = crypto.randomUUID();
    const inserted = await insertDoneJobIfUnderLimit(db, {
      id,
      requester,
      spec,
      specKey: key,
      resultHash: existing.resultHash,
      now: nowIso,
      sinceIso,
      maxPerDay: MAX_JOBS_PER_DAY,
    });
    if (!inserted) return json({ error: "LAB_JOB_LIMIT_DAILY" }, 429);
    return json({ job: { id, status: "done", resultHash: existing.resultHash, spec } }, 200);
  }

  const id = crypto.randomUUID();
  const inserted = await insertQueuedJobIfEligible(db, {
    id,
    requester,
    spec,
    specKey: key,
    now: nowIso,
    sinceIso,
    maxPerDay: MAX_JOBS_PER_DAY,
    maxActive: MAX_QUEUED_JOBS,
  });
  if (inserted) {
    return json({ job: { id, status: "queued", resultHash: null, spec } }, 201);
  }
  // The conditional insert refused: either a queued/running job already covers this exact spec (dedupe against
  // in-flight work), or a limit was hit. This read only shapes the response — the write above already decided
  // the outcome atomically, so a benign race here could at worst show a stale status, never double-write.
  const active = await activeJobBySpecKey(db, key);
  if (active) {
    // GPT-6 Sol review round 2: returning someone else's in-flight job must not let a requester who is
    // themselves already at the daily cap bypass it — they created no new row, but they still got service.
    if ((await countJobsToday(db, requester, sinceIso)) >= MAX_JOBS_PER_DAY) {
      return json({ error: "LAB_JOB_LIMIT_DAILY" }, 429);
    }
    return json({ job: { id: active.id, status: active.status, resultHash: active.resultHash, spec: active.spec } }, 200);
  }
  // Neither a duplicate nor a limit explains it on their own by construction, so one of the two caps the
  // conditional insert checked must have been it; this read only picks the right word for the 429, same
  // "response-shaping, not decision-making" read as the one just above (otto/mamoru-astro#28 follow-up: the
  // status card names the actual limit with its number, which needs to know which one was hit).
  if ((await countJobsToday(db, requester, sinceIso)) >= MAX_JOBS_PER_DAY) {
    return json({ error: "LAB_JOB_LIMIT_DAILY" }, 429);
  }
  return json({ error: "LAB_JOB_LIMIT_QUEUED" }, 429);
}

// ---- "Preguntar al Lab" (otto/mamoru-astro#30, spec 008 phase 2, AL-50): threads and agent jobs ----

export async function handleLabThreads(db: D1Db | undefined, owner: string): Promise<Response> {
  if (!db) return json({ threads: [] });
  return json({ threads: await threadsByOwner(db, owner) });
}

/** Every `runId` a thread's answers cite (claim/verdict runs, verdict `against` when it is another run, chart
 * runIds), resolved once here so the client never has to chase a second round trip per block to render a claim
 * chip's label or a verdict's sentence. */
function collectCitedRunIds(jobs: AgentJobRow[]): Set<string> {
  const ids = new Set<string>();
  for (const job of jobs) {
    const answer = job.answer as { blocks?: unknown[] } | null;
    if (!answer || !Array.isArray(answer.blocks)) continue;
    for (const raw of answer.blocks) {
      const b = raw as Record<string, unknown>;
      if (b.type === "claim" && typeof b.runId === "string") ids.add(b.runId);
      else if (b.type === "verdict") {
        if (typeof b.runId === "string") ids.add(b.runId);
        if (typeof b.against === "string" && b.against !== "hold" && b.against !== "usdc") ids.add(b.against);
      } else if (b.type === "chart" && Array.isArray(b.runIds)) {
        for (const r of b.runIds) if (typeof r === "string") ids.add(r);
      }
    }
  }
  return ids;
}

export async function handleLabThread(db: D1Db | undefined, owner: string, id: string): Promise<Response> {
  if (!db) return json({ error: "LAB_THREAD_NOT_FOUND" }, 404);
  const thread = await threadById(db, id);
  if (!thread || thread.owner !== owner) return json({ error: "LAB_THREAD_NOT_FOUND" }, 404);
  const jobs = await agentJobsByThread(db, id);
  const runIds = collectCitedRunIds(jobs);
  const runs: Record<string, Awaited<ReturnType<typeof runSummaryByHash>>> = {};
  for (const hash of runIds) {
    const summary = await runSummaryByHash(db, hash);
    if (summary) runs[hash] = summary;
  }
  // AL-41 footer, "shadow cost if present": priced only when lab_prices has rows and the job's own cost meter
  // parsed cleanly; a job from before pricing was configured (or any shape surprise) just omits the figure.
  const prices = await loadShadowPriceTable(db, new Date().toISOString());
  const jobsOut = jobs.map((job) => {
    let shadowUsd: number | null = null;
    if (prices && job.cost && typeof job.cost === "object") {
      const c = job.cost as { modelCalls?: unknown; runs?: unknown; sweepCpuMs?: unknown };
      if (Array.isArray(c.modelCalls) && Array.isArray(c.runs) && typeof c.sweepCpuMs === "number") {
        try {
          shadowUsd = shadowCostUsd(c as { modelCalls: { model: string; promptTokens: number; completionTokens: number }[]; runs: { cpuMs: number }[]; sweepCpuMs: number }, prices);
        } catch {
          shadowUsd = null;
        }
      }
    }
    return { ...job, shadowUsd };
  });
  return json({ thread, jobs: jobsOut, runs });
}

/**
 * AL-01/AL-04: `POST /ops/lab/api/ask` — creates the thread when `threadId` is absent (title = the first 60
 * chars of the question) or reuses an existing one owned by this requester, then queues an agent job under the
 * same daily/queued caps the bench path uses (shared across both kinds by construction — see
 * insertQueuedAgentJobIfEligible). `windowId`, when given, rides along in the job's `spec_json` as the only
 * context the runner's catalog prompt needs about what the user was looking at; it is never itself validated
 * against the catalog here (the runner's own TRAIN-only resolution, AL-12a, is the authority on that).
 */
export async function handleLabAsk(db: D1Db | undefined, requester: string, input: unknown): Promise<Response> {
  if (!db) return json({ error: "LAB_SERVICE_UNAVAILABLE" }, 503);
  const b = (input ?? {}) as { threadId?: unknown; question?: unknown; windowId?: unknown };
  const check = validateQuestion(b.question);
  if (!check.ok) return json({ error: check.error }, 400);
  const windowId = typeof b.windowId === "string" && b.windowId ? b.windowId : null;
  const nowIso = new Date().toISOString();

  let threadId: string;
  if (typeof b.threadId === "string" && b.threadId) {
    const thread = await threadById(db, b.threadId);
    if (!thread || thread.owner !== requester) return json({ error: "LAB_THREAD_NOT_FOUND" }, 404);
    threadId = thread.id;
    await touchThread(db, threadId, nowIso);
  } else {
    threadId = crypto.randomUUID();
    await insertThread(db, { id: threadId, owner: requester, title: threadTitleFromQuestion(check.question), now: nowIso });
  }

  const id = crypto.randomUUID();
  const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const inserted = await insertQueuedAgentJobIfEligible(db, {
    id,
    requester,
    threadId,
    question: check.question,
    windowId,
    now: nowIso,
    sinceIso,
    maxPerDay: MAX_JOBS_PER_DAY,
    maxActive: MAX_QUEUED_JOBS,
  });
  if (!inserted) {
    // No dedupe path here (spec_key is unique per job by construction, see insertQueuedAgentJobIfEligible), so
    // a refusal only ever means one of the two caps — same "response-shaping read" as handleLabCreateJob above.
    if ((await countJobsToday(db, requester, sinceIso)) >= MAX_JOBS_PER_DAY) {
      return json({ error: "LAB_JOB_LIMIT_DAILY" }, 429);
    }
    return json({ error: "LAB_JOB_LIMIT_QUEUED" }, 429);
  }
  return json({ threadId, job: { id, status: "queued", question: check.question } }, 201);
}
