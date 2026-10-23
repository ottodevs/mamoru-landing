// otto/mamoru-astro#24: the console shell and its components, in Mamoru's identity (the app's and the landing's
// tokens: rice, paper, ink, wash, emerald, stone; Noto Serif for words and figures, IBM Plex Mono for labels and
// data). "Paper" is the default; "Night" is the same palette inverted to sumi ink, not a generic dark theme.
// Appended after OPS_STYLE, so the older sections (Mails, Experiments, Settings, Functions, Archive, Infra) keep
// their rules and pick up the theme through the shared tokens.
export const CONSOLE_STYLE = `
@font-face { font-family: "IBM Plex Mono"; src: url("/fonts/plex-mono-400.woff2") format("woff2"); font-weight: 400; font-style: normal; font-display: swap; }
@font-face { font-family: "IBM Plex Mono"; src: url("/fonts/plex-mono-700.woff2") format("woff2"); font-weight: 700; font-style: normal; font-display: swap; }
:root {
  --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  --serif: "Noto Serif", Georgia, "Times New Roman", serif;
  --sheet: color-mix(in oklab, var(--paper) 72%, transparent);
  --sheet-2: color-mix(in oklab, var(--wash) 38%, var(--paper));
  --hair: rgba(15, 15, 14, 0.12);
  --hair-2: rgba(15, 15, 14, 0.2);
  --em: var(--emerald);
  --em-wash: rgba(47, 93, 80, 0.12);
  --umber: #8c5a2b;
  --good: #2f6b46; --warnc: #8a6410; --badc: #9b2c2c; --infoc: #3d5a80;
  --rail: 15.5rem;
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --rice: #121311; --paper: #191a17; --ink: #efe9dd; --wash: #3a3832; --stone: #9c968a; --muted: #a69f92;
  --emerald: #79b39d; --rule: rgba(239, 233, 221, 0.14); --rule-soft: rgba(239, 233, 221, 0.07);
  --hair: rgba(239, 233, 221, 0.1); --hair-2: rgba(239, 233, 221, 0.18);
  --em-wash: rgba(121, 179, 157, 0.14); --umber: #c79563;
  --good: #7cc29a; --warnc: #d8ac54; --badc: #e07a6a; --infoc: #8fb0d8;
  --sheet: color-mix(in oklab, var(--paper) 86%, transparent);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --rice: #121311; --paper: #191a17; --ink: #efe9dd; --wash: #3a3832; --stone: #9c968a; --muted: #a69f92;
    --emerald: #79b39d; --rule: rgba(239, 233, 221, 0.14); --rule-soft: rgba(239, 233, 221, 0.07);
    --hair: rgba(239, 233, 221, 0.1); --hair-2: rgba(239, 233, 221, 0.18);
    --em-wash: rgba(121, 179, 157, 0.14); --umber: #c79563;
    --good: #7cc29a; --warnc: #d8ac54; --badc: #e07a6a; --infoc: #8fb0d8;
    --sheet: color-mix(in oklab, var(--paper) 86%, transparent);
  }
}
:root[data-theme="dark"] body { background-image: none; }
:root[data-theme="dark"] .ops-brand img { filter: invert(0.92) sepia(0.15); }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) body { background-image: none; } :root:not([data-theme="light"]) .ops-brand img { filter: invert(0.92) sepia(0.15); } }
html, body { overflow-x: clip; }

/* ---- shell ---- */
.c-app { display: grid; grid-template-columns: var(--rail) minmax(0, 1fr); min-height: 100dvh; }
.c-rail { position: sticky; top: 0; height: 100dvh; display: flex; flex-direction: column; gap: 1.4rem; padding: 1.3rem 0.9rem; border-right: 1px solid var(--hair); }
.c-rail .ops-brand { padding: 0 0.55rem; font-size: 1.08rem; }
.c-rail .ops-nav { display: grid; gap: 0.1rem; align-items: stretch; }
.c-rail .ops-nav a { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; padding: 0.5rem 0.6rem; border: 0; border-radius: 6px; font-size: 1rem; color: var(--ink); line-height: 1.25; }
.c-rail .ops-nav a:hover { background: var(--sheet); color: var(--ink); }
.c-rail .ops-nav a[aria-current="page"] { background: var(--sheet-2); box-shadow: inset 2px 0 0 var(--em); }
.c-rail .ops-nav .c-group { margin: 0.9rem 0.6rem 0.25rem; font: 0.66rem/1 var(--mono); letter-spacing: 0.16em; text-transform: uppercase; color: var(--stone); }
.c-rail .ops-nav a.minor { font-size: 0.92rem; color: var(--muted); padding-block: 0.38rem; }
.c-rail .ops-nav a.minor[aria-current="page"] { color: var(--ink); }
.c-rail .ops-nav a.out::after { content: "\\2197"; font-size: 0.8em; color: var(--stone); }
.c-rail-foot { margin-top: auto; display: grid; gap: 0.6rem; padding: 0 0.55rem; font-size: 0.85rem; color: var(--muted); }
.c-rail-foot .ops-who { margin: 0; display: grid; gap: 0.25rem; }
.c-theme { justify-self: start; font: 0.72rem/1 var(--mono); letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink); background: transparent; border: 1px solid var(--hair-2); border-radius: 999px; padding: 0.42rem 0.75rem; cursor: pointer; }
.c-theme:hover { border-color: var(--ink); }
.c-app .ops-page { max-width: 84rem; width: 100%; margin: 0; padding: 0 clamp(1rem, 3vw, 2.6rem) 4rem; min-width: 0; }
.c-tabs { display: none; }

/* ---- view chrome ---- */
.c-view { display: grid; gap: 1.1rem; padding-top: 0.2rem; }
.c-head { position: sticky; top: 0; z-index: 4; display: flex; flex-wrap: wrap; align-items: center; gap: 0.7rem 1.1rem; padding: 1.1rem 0 0.9rem; border-bottom: 1px solid var(--hair); background: color-mix(in oklab, var(--rice) 90%, transparent); backdrop-filter: blur(8px); }
.c-head h1 { margin: 0 auto 0 0; font-size: 1.55rem; font-weight: 400; letter-spacing: -0.01em; }
.c-head h1:focus { outline: none; }
.c-seg { display: inline-flex; padding: 3px; border: 1px solid var(--hair-2); border-radius: 999px; gap: 2px; }
.c-seg a { font: 0.72rem/1 var(--mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); text-decoration: none; padding: 0.45rem 0.8rem; border-radius: 999px; white-space: nowrap; }
.c-seg a:hover { color: var(--ink); }
.c-seg a[aria-current="true"] { background: var(--ink); color: var(--rice); }
.c-fresh { display: inline-flex; align-items: center; gap: 0.5rem; font: 0.72rem/1.2 var(--mono); letter-spacing: 0.04em; color: var(--muted); }
.c-fresh i { width: 7px; height: 7px; border-radius: 2px; background: var(--em); }

/* ---- surfaces ---- */
.c-grid { display: grid; gap: 1.1rem; }
.c-grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.c-grid.hero { grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); }
.c-sheet { background: var(--sheet); border: 1px solid var(--hair); border-radius: 4px; padding: 1.15rem 1.25rem 1.2rem; min-width: 0; }
.c-sheet-h { margin-bottom: 0.9rem; }
.c-sheet-h h2 { margin: 0; font-size: 1.08rem; font-weight: 400; }
.c-sheet-h p { margin: 0.2rem 0 0; font-size: 0.88rem; color: var(--muted); line-height: 1.4; }
.c-k { margin: 0; font: 0.68rem/1.2 var(--mono); letter-spacing: 0.16em; text-transform: uppercase; color: var(--stone); }
.c-days { width: 100%; border-collapse: collapse; font-size: 0.9rem; font-variant-numeric: tabular-nums; }
.c-days th { padding: 0 0.5rem 0.5rem; text-align: left; font: 0.64rem/1.2 var(--mono); letter-spacing: 0.14em; text-transform: uppercase; color: var(--stone); }
.c-days td { padding: 0.45rem 0.5rem; border-top: 1px solid var(--hair); }
.c-days .n { text-align: right; }
.c-days td.neg { color: var(--umber); }
.c-empty { margin: 0; padding: 0.9rem 1rem; border: 1px dashed var(--hair-2); border-radius: 4px; color: var(--muted); font-size: 0.95rem; line-height: 1.45; }
.c-prose { margin: 0 0 0.9rem; font-size: 1.05rem; line-height: 1.5; max-width: 46rem; }
.c-prose b { font-weight: 400; color: var(--em); }
.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.dim { color: var(--muted); }
.c-mono { font-family: var(--mono); font-size: 0.86rem; letter-spacing: 0.02em; }

/* hero */
.c-hero { padding: 1.4rem 1.5rem 1rem; background: linear-gradient(180deg, var(--em-wash), transparent 55%), var(--sheet); }
.c-big { margin: 0.35rem 0 0.3rem; font-size: clamp(3rem, 7vw, 4.9rem); line-height: 1; letter-spacing: -0.03em; }
.c-line { margin: 0 0 1rem; display: flex; flex-wrap: wrap; gap: 0.3rem 1.3rem; font-size: 0.98rem; color: var(--muted); }
.c-line b { font-weight: 400; color: var(--ink); }
.c-foot { margin: 0.6rem 0 0; font-size: 0.82rem; color: var(--muted); line-height: 1.45; }

/* figures */
.c-figs { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border: 1px solid var(--hair); border-radius: 4px; background: var(--sheet); }
.c-figs.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.c-fig { display: grid; gap: 0.3rem; align-content: start; padding: 1rem 1.15rem 1.1rem; min-width: 0; }
.c-fig + .c-fig { border-left: 1px solid var(--hair); }
.c-fig .c-k { margin-bottom: 0.15rem; }
.c-v { font-size: 1.9rem; line-height: 1.05; letter-spacing: -0.015em; }
.c-note { font-size: 0.84rem; color: var(--muted); line-height: 1.4; }
.c-fig .c-meter { margin-top: 0.4rem; }

/* status: a small square seal, not a dot */
.c-seal { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-top: 0.42rem; flex: none; background: var(--stone); }
.c-seal.bad { background: var(--badc); } .c-seal.warn { background: var(--warnc); } .c-seal.info { background: var(--infoc); } .c-seal.good { background: var(--good); }
.c-chip { display: inline-flex; align-items: center; padding: 0.22rem 0.55rem; border-radius: 999px; font: 0.68rem/1.2 var(--mono); letter-spacing: 0.06em; text-transform: uppercase; white-space: nowrap; border: 1px solid var(--hair-2); color: var(--muted); }
.c-chip.good { color: var(--good); border-color: color-mix(in oklab, var(--good) 40%, transparent); }
.c-chip.warn { color: var(--warnc); border-color: color-mix(in oklab, var(--warnc) 45%, transparent); }
.c-chip.bad { color: var(--badc); border-color: color-mix(in oklab, var(--badc) 45%, transparent); }

/* alerts */
.c-alerts { list-style: none; margin: 0; padding: 0; display: grid; }
.c-alerts li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 0.75rem; align-items: start; padding: 0.75rem 0; border-top: 1px solid var(--hair); }
.c-alerts li:first-child { border-top: 0; padding-top: 0; }
.c-alerts b { display: block; font-weight: 400; font-size: 1rem; line-height: 1.35; }
.c-alerts span { display: block; font-size: 0.86rem; color: var(--muted); line-height: 1.4; overflow-wrap: anywhere; }
.c-open, .c-linkish { font: 0.7rem/1 var(--mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink); background: transparent; border: 1px solid var(--hair-2); border-radius: 999px; padding: 0.4rem 0.65rem; cursor: pointer; }
.c-open:hover, .c-linkish:hover { border-color: var(--ink); }
.c-linkish { text-transform: none; letter-spacing: 0.02em; font-size: 0.8rem; }

/* stacks, meters, legends */
.c-stack { display: flex; gap: 2px; height: 12px; border-radius: 2px; overflow: hidden; background: var(--hair); }
.c-stack.tall { height: 18px; }
.c-stack span { display: block; height: 100%; }
.emerald { background: var(--em); } .ink { background: var(--ink); } .stone { background: var(--stone); } .wash { background: var(--wash); } .umber { background: var(--umber); }
.c-legend { list-style: none; margin: 0.9rem 0 0; padding: 0; display: grid; gap: 0.45rem; }
.c-legend li { display: grid; grid-template-columns: auto auto minmax(0, 1fr) auto auto; gap: 0.55rem; align-items: baseline; font-size: 0.95rem; }
.c-legend li i { width: 10px; height: 10px; border-radius: 2px; align-self: center; }
.c-legend li b { font-weight: 400; }
.c-legend li span { color: var(--muted); font-size: 0.86rem; }
.c-legend li span.n { color: var(--ink); min-width: 3.8rem; }
.c-legend.inline { display: flex; flex-wrap: wrap; gap: 0.4rem 1rem; margin: 0 0 0.6rem; }
.c-legend.inline li { display: flex; gap: 0.45rem; font: 0.7rem/1 var(--mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
.c-meter { display: block; height: 8px; border-radius: 2px; background: var(--hair); overflow: hidden; }
.c-meter i { display: block; height: 100%; background: var(--em); border-radius: 2px; }
.c-meter.warn i { background: var(--warnc); } .c-meter.bad i { background: var(--badc); }
.c-funnel { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.7rem; }
.c-funnel li { display: grid; grid-template-columns: 8.5rem minmax(0, 1fr) 2.6rem 2.6rem; gap: 0.8rem; align-items: center; font-size: 0.98rem; }
.c-funnel.codes li { grid-template-columns: minmax(0, 13rem) minmax(0, 1fr) 2.4rem; }
.c-funnel.codes .c-mono { overflow-wrap: anywhere; font-size: 0.78rem; }

/* leaderboard */
.c-lb { list-style: none; margin: 0; padding: 0; display: grid; }
.c-lb-head, .c-lb-row { display: grid; grid-template-columns: 6.5rem minmax(0, 1fr) 4.4rem 5rem 4.2rem; gap: 0.9rem; align-items: center; }
.c-lb-head { padding: 0 0.5rem 0.5rem; font: 0.64rem/1.2 var(--mono); letter-spacing: 0.14em; text-transform: uppercase; color: var(--stone); }
.c-lb-row { width: 100%; text-align: left; font: inherit; color: inherit; background: transparent; border: 0; border-top: 1px solid var(--hair); padding: 0.75rem 0.5rem; cursor: pointer; }
.c-lb li:first-child .c-lb-row { border-top: 0; }
.c-lb-row:hover { background: var(--sheet-2); }
.c-lb-row em { font-style: normal; font: 0.62rem/1 var(--mono); text-transform: uppercase; letter-spacing: 0.1em; color: var(--stone); }
.c-lb-row.compact { grid-template-columns: 6.5rem minmax(0, 1fr) 6rem; row-gap: 0.45rem; }
.c-lb-row.compact .c-chips { grid-column: 1 / -1; grid-row: 2; }
.c-bar { display: grid; gap: 0.3rem; }
.c-bar i { display: block; height: 7px; border-radius: 2px; background: var(--em); min-width: 3px; }
.c-bar small { font-size: 0.82rem; color: var(--muted); font-variant-numeric: tabular-nums; }

/* pools */
.c-pools { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.7rem; }
.c-pools li { padding: 0.85rem 0.95rem; border: 1px solid var(--hair); border-radius: 4px; background: var(--sheet-2); }
.c-pool-top { display: flex; justify-content: space-between; align-items: baseline; gap: 0.8rem; }
.c-pool-top b { display: block; font-weight: 400; font-size: 1.02rem; }
.c-pool-top span { font-size: 0.82rem; color: var(--muted); }
.c-pool-apr { font-size: 1.5rem !important; color: var(--ink) !important; }
.c-pools dl { display: grid; grid-template-columns: 1fr auto; gap: 0.25rem 0.8rem; margin: 0.6rem 0 0; font-size: 0.88rem; }
.c-pools dt { color: var(--muted); } .c-pools dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }

/* feeds */
.c-feed { list-style: none; margin: 0; padding: 0; display: grid; }
.c-feed li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 0.7rem; align-items: center; padding: 0.55rem 0; border-top: 1px solid var(--hair); font-size: 0.95rem; }
.c-feed li:first-child { border-top: 0; }

/* charts */
.c-chart { position: relative; min-height: var(--h, 180px); margin: 0.2rem 0 0; }
.c-svg { display: block; width: 100%; height: auto; overflow: visible; }
.c-svg text { fill: var(--muted); font: 10.5px var(--mono); letter-spacing: 0.02em; }
.c-svg .gl { stroke: var(--hair); } .c-svg .ax { stroke: var(--hair-2); }
.c-svg .stroke { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.c-svg .area { opacity: 0.13; }
.c-svg.tone-emerald .stroke { stroke: var(--em); } .c-svg.tone-emerald .area, .c-svg.tone-emerald .end { fill: var(--em); }
.c-svg.tone-ink .stroke { stroke: var(--ink); } .c-svg.tone-ink .area, .c-svg.tone-ink .end { fill: var(--ink); }
.c-svg.tone-umber .stroke { stroke: var(--umber); } .c-svg.tone-umber .area, .c-svg.tone-umber .end { fill: var(--umber); }
.c-svg .c-b { fill: var(--em); }
.c-svg.tone-ink .c-b { fill: var(--ink); opacity: 0.72; }
.c-svg .c-b.t-emerald { fill: var(--em); opacity: 1; } .c-svg .c-b.t-ink { fill: var(--ink); opacity: 1; } .c-svg .c-b.t-stone { fill: var(--stone); } .c-svg .c-b.t-wash { fill: var(--wash); }
.c-svg .end { stroke: var(--paper); stroke-width: 2; }
.c-svg .thr { stroke: var(--ink); stroke-opacity: 0.4; }
.c-svg text.thr-l { fill: var(--ink); opacity: 0.7; }
.c-svg .c-cross { stroke: var(--hair-2); opacity: 0; } .c-svg .c-cross.on { opacity: 1; }
.c-tip { position: absolute; pointer-events: none; transform: translate(-50%, calc(-100% - 10px)); background: var(--paper); border: 1px solid var(--hair-2); border-radius: 4px; padding: 0.4rem 0.6rem; white-space: nowrap; opacity: 0; transition: opacity 0.12s; z-index: 2; }
.c-tip.on { opacity: 1; }
.c-tip b { display: block; font-weight: 400; font-size: 0.98rem; }
.c-tip span { font: 0.66rem/1.2 var(--mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
.c-data { margin-top: 0.5rem; font-size: 0.82rem; color: var(--muted); }
.c-data summary { cursor: pointer; font: 0.66rem/1 var(--mono); letter-spacing: 0.12em; text-transform: uppercase; }
.c-data table { margin-top: 0.5rem; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.c-data td { padding: 0.15rem 1.2rem 0.15rem 0; }

/* drawer */
.c-scrim { position: fixed; inset: 0; z-index: 20; background: rgba(15, 15, 14, 0.38); opacity: 0; pointer-events: none; transition: opacity 0.2s; }
.c-drawer { position: fixed; top: 0; right: 0; bottom: 0; z-index: 21; width: min(32rem, 100vw); overflow-y: auto; background: var(--rice); border-left: 1px solid var(--hair-2); padding: 1.2rem 1.3rem calc(2rem + env(safe-area-inset-bottom, 0px)); transform: translateX(102%); transition: transform 0.28s cubic-bezier(0.2, 0.8, 0.2, 1); }
.c-drawer-open .c-scrim { opacity: 1; pointer-events: auto; }
.c-drawer-open .c-drawer { transform: none; }
.c-close { float: right; font: 0.7rem/1 var(--mono); letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink); background: transparent; border: 1px solid var(--hair-2); border-radius: 999px; padding: 0.45rem 0.75rem; cursor: pointer; }
.c-drawer-in { display: grid; gap: 1rem; clear: both; padding-top: 0.6rem; }
.c-acct { margin: 0.1rem 0 0; font-family: var(--mono); font-weight: 400; font-size: 1.5rem; letter-spacing: 0.02em; }
.c-poslist { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.55rem; }
.c-pos { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.3rem 0.8rem; align-items: center; padding: 0.75rem 0.85rem; border: 1px solid var(--hair); border-radius: 4px; background: var(--sheet-2); }
.c-pos b { display: block; font-weight: 400; }
.c-pos div span, .c-pos > span.n { font-size: 0.84rem; color: var(--muted); }
.c-pos > span.n:last-child { text-align: right; }
.c-pos > span.n:nth-of-type(1) { text-align: left; }

/* authorization and cap per account (otto/mamoru-astro#25) */
.c-chip.em { color: var(--em); border-color: color-mix(in oklab, var(--em) 45%, transparent); }
.c-chips { display: inline-flex; flex-wrap: wrap; gap: 0.3rem; }
.c-dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 0.45rem 1rem; margin: 0.9rem 0; font-size: 0.92rem; align-items: baseline; }
.c-dl dt { font: 0.66rem/1.4 var(--mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--stone); }
.c-dl dd { margin: 0; overflow-wrap: anywhere; }
.c-caplines { list-style: none; margin: 0.8rem 0 0; padding: 0; display: grid; gap: 0.45rem; }
.c-caplines li { padding-left: 0.8rem; border-left: 1px solid var(--hair-2); font-size: 0.9rem; line-height: 1.45; overflow-wrap: anywhere; }
.c-grants { grid-column: 1 / -1; list-style: none; margin: 0.3rem 0 0; padding: 0; display: grid; gap: 0.35rem; }
.c-grants li { display: grid; grid-template-columns: minmax(0, 8rem) minmax(0, 1fr) 4.6rem; gap: 0.6rem; align-items: center; font-size: 0.84rem; color: var(--muted); }
.c-capform { display: grid; grid-template-columns: 8.5rem minmax(0, 1fr); gap: 0.55rem 0.8rem; align-items: baseline; margin-top: 1rem; padding-top: 0.9rem; border-top: 1px solid var(--hair); }
.c-capform label { font: 0.68rem/1.3 var(--mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--stone); }
.c-capform input { min-width: 0; width: 100%; border: 0; border-bottom: 1px solid var(--hair-2); background: none; padding: 0.25rem 0; font-size: 1rem; }
.c-capform input:focus-visible { outline: none; border-bottom-color: var(--em); }
.c-capin { display: flex; align-items: baseline; gap: 0.5rem; font-variant-numeric: tabular-nums; }
.c-capin input { max-width: 9rem; font-size: 1.25rem; }
.c-capform button { grid-column: 2; justify-self: start; }
.c-capform.back { margin-top: 0.6rem; padding-top: 0.6rem; }
.c-capform button.quiet { background: transparent; color: var(--ink); border: 1px solid var(--hair-2); }
.c-capform button.quiet:hover { border-color: var(--ink); }
.c-owncaps li { grid-template-columns: auto minmax(0, 1fr) auto; align-items: start; }
.c-owncaps li div { display: grid; gap: 0.15rem; }
.c-owncaps li b { font-weight: 400; }
.c-owncaps li span { font-size: 0.84rem; color: var(--muted); overflow-wrap: anywhere; }
.c-confirm { border-color: var(--ink); }
.c-confirm form { margin-top: 1rem; display: flex; flex-wrap: wrap; gap: 0.8rem; align-items: baseline; }
@media (max-width: 480px) { .c-owncaps li { grid-template-columns: auto minmax(0, 1fr); } .c-owncaps li > .c-chip { grid-column: 2; justify-self: start; } .c-capform { grid-template-columns: minmax(0, 1fr); } .c-capform button { grid-column: 1; } .c-grants li { grid-template-columns: minmax(0, 1fr) 4.2rem; } .c-grants li .c-meter { grid-column: 1 / -1; grid-row: 2; } }

@media (prefers-reduced-motion: reduce) { .c-drawer, .c-scrim, .c-tip { transition: none; } }
@media (max-width: 1180px) { .c-figs { grid-template-columns: repeat(2, minmax(0, 1fr)); } .c-figs .c-fig:nth-child(3) { border-left: 0; } .c-figs .c-fig:nth-child(n + 3) { border-top: 1px solid var(--hair); } .c-grid.hero { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 860px) {
  .c-app { grid-template-columns: minmax(0, 1fr); }
  .c-rail { display: none; }
  .c-app .ops-page { padding-bottom: calc(5.5rem + env(safe-area-inset-bottom, 0px)); }
  .c-grid.two { grid-template-columns: minmax(0, 1fr); }
  .c-tabs { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); position: fixed; left: 0; right: 0; bottom: 0; z-index: 10; padding: 0.35rem 0.35rem calc(0.35rem + env(safe-area-inset-bottom, 0px)); background: color-mix(in oklab, var(--rice) 94%, transparent); backdrop-filter: blur(10px); border-top: 1px solid var(--hair-2); }
  .c-tabs a { text-align: center; padding: 0.6rem 0.1rem; border-radius: 4px; color: var(--muted); text-decoration: none; font: 0.62rem/1.1 var(--mono); letter-spacing: 0.06em; text-transform: uppercase; }
  .c-tabs a[aria-current="page"] { color: var(--ink); background: var(--sheet-2); }
  .c-lb-head, .c-lb-row { grid-template-columns: 5.8rem minmax(0, 1fr) 3.8rem; gap: 0.7rem; }
  .c-lb-row.compact { grid-template-columns: 5.8rem minmax(0, 1fr); }
  .c-lb-head .wide, .c-lb-row .wide { display: none; }
  .c-funnel li { grid-template-columns: 6.5rem minmax(0, 1fr) 2.2rem; }
  .c-funnel li .dim { display: none; }
  .c-head { padding-top: 0.9rem; }
  .c-head h1 { flex-basis: 100%; }
}
@media (max-width: 480px) { .c-v { font-size: 1.5rem; } .c-fig { padding: 0.85rem 0.9rem 0.95rem; } .c-legend li { grid-template-columns: auto minmax(0, 1fr) auto auto; } .c-legend li span:not(.n) { display: none; } .c-legend li span.n { min-width: 2.8rem; } }
`;
