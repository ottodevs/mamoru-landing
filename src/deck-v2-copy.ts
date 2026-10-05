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
    axis: "time",
    asks: ["Harvest?", "Exit?", "Stay?"],
    question: ["Your profits,", "where do they go?"],
  },
  loop: {
    eyebrow: "The solution",
    // Names for the three positions, shown on the deck only. On the landing the allocation chart names them.
    labels: { paired: "Bluechips", mercenary: "Mercenary", stables: "Stablecoins" },
  },
  // Six lines the speaker explains. A click brings the explanations up, for whoever reads the deck alone.
  trust: {
    heading: "Why trust Mamoru",
    rows: [
      {
        who: "You keep control",
        what: "Your wallet is a smart account, owned by a passkey on your device. Mamoru never holds the key that can move your money out.",
      },
      {
        who: "A key with limits",
        what: "Mamoru works through a session key. It can act only inside a written policy and you can revoke it anytime.",
      },
      { who: "Built on Uniswap", what: "Where the capital works. Mamoru swaps and provides liquidity on Uniswap, nothing else." },
      {
        who: "Half in stablecoins by rule",
        what: "Three positions. Mamoru keeps half of the capital in stablecoins, and the yield becomes stablecoins.",
      },
      { who: "No lockup", what: "Withdraw stablecoins anytime. Mamoru rebalances the rest." },
      { who: "No token", what: "Nothing to buy, hold or farm." },
    ],
  },
  built: {
    eyebrow: "How it's built",
    heading: "Under the stone.",
    layers: [
      { who: "Your account", what: "A Safe, owned by a passkey on your device. The server never holds a key." },
      { who: "Uniswap", what: "Where the capital works. The agent swaps and provides liquidity on Uniswap v3, nothing else." },
      { who: "Session key", what: "The agent acts only inside a written policy. Revoke it anytime, leave without us." },
      { who: "Curvegrid", what: "MultiBaas indexes every pool event, checked against the chain, 10 of 10." },
      { who: "Chain snapshots", what: "The chain forked at a real block. Leaked-key attacks replayed until the chain refuses them all." },
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
    eyebrow: "Live",
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
