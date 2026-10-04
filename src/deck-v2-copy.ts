/**
 * Words for mamoru.lol/deck-v2: the working copy of the next deck. The Tokyo deck stays untouched
 * at /deck (deck-copy.ts). The cover takes its words from the landing hero (open-copy.ts), and the
 * third slide is the landing's own "How it works". Slides guide, the speaker tells.
 */

export const DECK_V2 = {
  title: "Mamoru · Deck v2",
  description: "Savings, automated.",
  // 150% APY is the bait that falls to zero on screen. It is not a Mamoru rate.
  problem: {
    eyebrow: "The problem",
    aria: "Your profits, where do they go?",
    from: 150,
    unit: "APY",
    day: "Day",
    days: 30,
    asks: ["Harvest?", "Exit?", "Stay?"],
    question: ["Your profits,", "where do they go?"],
  },
  loop: {
    eyebrow: "The solution",
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
    href: "https://san.mamoru.lol",
    hrefLabel: "san.mamoru.lol",
  },
  demo: {
    eyebrow: "Live on Base",
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
