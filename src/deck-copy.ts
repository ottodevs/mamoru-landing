/**
 * Words for mamoru.lol/deck. Slides guide, the speaker tells.
 * No yield figures: the chips on the problem slide are the market, not Mamoru.
 */

export const DECK = {
  title: "Mamoru · Deck",
  description: "Non-custodial savings on Base. Yield is reinvested until you transfer.",
  intro: {
    lede: "Non-custodial savings on Base. Yield is reinvested until you transfer.",
    kicker: "ETHGlobal Tokyo 2026",
  },
  problem: {
    eyebrow: "The problem",
    heading: ["DeFi makes yield easy.", "Keeping it is a job."],
    points: [
      "Fragmented. Hundreds of pools, every APY counted differently.",
      "Time. Harvest, exit, stay? The decisions never stop.",
      "Trade-offs. The best rates want your funds locked, or your trust.",
    ],
    chips: [
      { label: "APR 4.2%", x: 4, y: 6, tone: "" },
      { label: "APY 140%*", x: 50, y: 0, tone: "fade" },
      { label: "locked 30d", x: 24, y: 24, tone: "" },
      { label: "points?", x: 74, y: 22, tone: "" },
      { label: "Harvest?", x: 8, y: 46, tone: "ask" },
      { label: "Exit?", x: 44, y: 50, tone: "ask" },
      { label: "Stay?", x: 72, y: 44, tone: "ask" },
      { label: "APR 0.9%", x: 2, y: 76, tone: "" },
      { label: "7d avg 11%", x: 36, y: 82, tone: "" },
      { label: "claim · swap · redeposit", x: 56, y: 70, tone: "" },
    ],
  },
  solution: {
    eyebrow: "Mamoru",
    heading: ["Deposit.", "Forget.", "It keeps working."],
    points: [
      "Your capital goes to work in curated Uniswap pools.",
      "Yield is reinvested until you transfer.",
      "No lockup. Transfer out anytime, to any wallet.",
      "Your account, your keys. Mamoru never holds them.",
    ],
    versus: [
      { who: "Bank", note: "your money, their rate" },
      { who: "Vaults", note: "locked, or trust us" },
      { who: "Mamoru", note: "yours, working, liquid" },
    ],
    caption: "守る · to protect",
  },
  built: {
    eyebrow: "How it's built",
    heading: "Under the stone.",
    layers: [
      { who: "Your account", what: "A Safe on Base, owned by a passkey on your device. The server never holds a key." },
      { who: "Uniswap", what: "Where the capital works. The agent swaps and provides liquidity on Uniswap v3, nothing else." },
      { who: "Session key", what: "The agent acts only inside a written policy. Revoke it anytime, leave without us." },
      { who: "Curvegrid", what: "MultiBaas indexes every pool event, checked against Base, 10 of 10." },
      { who: "Chain snapshots", what: "Base forked at a real block. Leaked-key attacks replayed until the chain refuses them all." },
    ],
  },
  more: {
    teaser: "One more thing…",
    eyebrow: "Mamoru San · x402",
    heading: "Agents pay agents. Ours checks first.",
    lede: "Every x402 payment is screened by Intercepta before it is signed, and before it is accepted.",
    verdicts: [
      { label: "PAY", note: "clean, under the cap", tone: "pay" },
      { label: "CAP", note: "doubt lowers the spend", tone: "hold" },
      { label: "HOLD", note: "silence never pays", tone: "hold" },
      { label: "REFUSE", note: "sanctioned payee, no signature", tone: "refuse" },
    ],
    note: "Settled live on Base Sepolia",
    href: "https://san.mamoru.lol",
    hrefLabel: "san.mamoru.lol",
  },
  demo: {
    eyebrow: "Live on Base · 25 USDC cap",
    heading: "Demo",
    href: "https://app.mamoru.lol",
    hrefLabel: "app.mamoru.lol",
    path: ["Sign in", "Fund", "Allocate", "Replay a market day", "Transfer", "Stop allocation"],
  },
  outro: {
    eyebrow: "What's next",
    heading: "The garden grows.",
    futures: [
      { title: "Continuity", body: "Tokyo is the first stone. Mumbai is next.", lead: true },
      { title: "An agent that curates", body: "AI finds and vets new pools and strategies, and explains every move.", lead: false },
      { title: "A risk for everyone", body: "More strategies, one simple account.", lead: false },
      { title: "Spend it", body: "A card on top of the stablecoins. A savings module for neobanks.", lead: false },
      { title: "Protection pool", body: "A slice of revenue set aside to insure savers.", lead: false },
    ],
    restart: "Start over",
    links: [
      { label: "mamoru.lol", href: "https://mamoru.lol" },
      { label: "github.com/ottodevs/mamoru", href: "https://github.com/ottodevs/mamoru" },
      { label: "@entermamoru", href: "https://x.com/entermamoru" },
    ],
  },
} as const;
