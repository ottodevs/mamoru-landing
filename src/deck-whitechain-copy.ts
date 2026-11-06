/**
 * Words for mamoru.lol/deck/whitechain: the go-to-market pitch to Whitechain (ETHGlobal Mumbai, Nov 2026).
 * Slides 01–05 are the main deck's (deck-copy.ts); everything here comes after them.
 * Figures are read from prod D1 and dated on the slide. Change them only with a new read.
 * Source: the Whitechain plan in ottodevs/mamoru docs/ethglobal-mumbai/whitechain-gtm.md.
 */

export const WHITECHAIN = {
  title: "Mamoru × Whitechain",
  description: "Savings, automated. A go-to-market plan for Whitechain.",
  canonical: "https://mamoru.lol/deck/whitechain",
  traction: {
    eyebrow: "Already in market",
    heading: ["Not an idea.", "A product people use."],
    figures: [
      { value: "56", label: "people opened an account" },
      { value: "16", label: "of them on 6 Nov, during Devcon and ETHGlobal Mumbai" },
      { value: "3.7k", label: "USDC working on Base" },
      { value: "2", label: "chains live: Base and Monad" },
    ],
    note: "Mainnet, real funds, since ETHGlobal Tokyo on 26 Sep. Read from our production database on 6 Nov 2026, 22:20 UTC.",
  },
  market: {
    eyebrow: "Market",
    heading: ["Idle crypto.", "Three bad options."],
    options: [
      { who: "On an exchange", what: "Low yield, and the money is not yours while it sits there." },
      { who: "In the wallet", what: "Safe, and earning nothing." },
      { who: "In DeFi", what: "Better yield, if you watch positions, ranges and gas every day." },
    ],
    ours: {
      who: "Mamoru",
      what: "Your money works on its own, stays yours, and you take it out whenever you want.",
    },
    model: "We earn 10 % of the yield we harvest. Revenue grows with deposits, not with headcount.",
  },
  segment: {
    eyebrow: "Segment",
    heading: ["People who hold crypto", "and don't know what to do with it."],
    rows: [
      {
        tag: "First",
        who: "Crypto natives",
        size: "500 – 1,000 USDC",
        what: "They read the policy and test it on their own phone. Their trust validates Mamoru for everyone else.",
      },
      {
        tag: "Then",
        who: "Holders who are not natives",
        size: "1,000 – 40,000 idle",
        what: "Where the volume is. The same people who keep crypto on an exchange: your retail.",
      },
    ],
  },
  channels: {
    eyebrow: "Channels",
    heading: "Three channels, already running.",
    rows: [
      {
        n: "01",
        who: "Founder-led, in person",
        what: "Live demos at Devcon and ETHGlobal Mumbai. The account is opened on their phone, then we follow up one by one within a day.",
        proof: "16 accounts in one day",
      },
      {
        n: "02",
        who: "A narrow network on purpose",
        what: "Farcaster as the beachhead: small, connected, and a few OG users who carry the word. Two to four weeks to show deposits, or we drop it.",
        proof: "A deadline, not a hope",
      },
      {
        n: "03",
        who: "Chain integrations",
        what: "Each chain we join brings its community. Monad was the first: a Growth bucket on Monad mainnet, reached through Circle CCTP.",
        proof: "Whitechain is next",
      },
    ],
  },
  offer: {
    eyebrow: "The offer",
    heading: ["Venues without users.", "Users without venues."],
    lede: "A new chain's hardest problem is the first liquidity. We solve both sides at once.",
    parts: [
      {
        who: "We deploy the AMM",
        what: "A Uniswap v3 fork: the venue our engine already operates on Base and Monad.",
      },
      {
        who: "Whitechain seeds it",
        what: "Launch liquidity in the stablecoin you choose first: USDT, EURC or USDC.",
      },
      {
        who: "Mamoru brings demand",
        what: "Every deposit becomes liquidity in that AMM from day one.",
      },
    ],
  },
  rollout: {
    eyebrow: "Rollout",
    heading: "We grow it on evidence.",
    steps: [
      {
        n: "01",
        who: "Integrate",
        what: "Whitechain gets its own chain file in our registry: a new chain is a new file, not a new engine. The AMM goes up, and every leaked-key attack is replayed on a fork.",
        kpi: "Attacks refused",
      },
      {
        n: "02",
        who: "Capped pilot",
        what: "A limit per account, as we started on Monad. Demos to the first users in person, with follow-up one by one.",
        kpi: "Funded accounts",
      },
      {
        n: "03",
        who: "Raise the cap",
        what: "Only as the numbers hold. Mamoru means to protect: the limit is part of the product.",
        kpi: "Deposits and retention",
      },
      {
        n: "04",
        who: "Open the path",
        what: "The engine opens to integrators and agents, and becomes the way WhiteBIT users become Whitechain users.",
        kpi: "Liquidity in the pool",
      },
    ],
  },
  ask: {
    eyebrow: "The ask",
    heading: "Three things from you.",
    asks: ["Liquidity for launch", "The stablecoin to start with", "One technical contact"],
    giveHeading: "What Whitechain gets",
    gives: ["An AMM on its chain", "A savings product, live", "A team that has already added a chain"],
  },
  close: {
    eyebrow: "Next step",
    heading: ["A capped pilot", "on Whitechain."],
    lede: "Try it now, on your phone.",
    href: "https://app.mamoru.lol",
    hrefLabel: "app.mamoru.lol",
    restart: "Start over",
    links: [
      { label: "mamoru.lol", href: "https://mamoru.lol" },
      { label: "github.com/ottodevs/mamoru", href: "https://github.com/ottodevs/mamoru" },
      { label: "@entermamoru", href: "https://x.com/entermamoru" },
    ],
  },
} as const;
