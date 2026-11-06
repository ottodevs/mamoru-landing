/**
 * Words for mamoru.lol/deck/whitechain: the go-to-market pitch to Whitechain (ETHGlobal Mumbai, Nov 2026).
 * Slides 01–04 are the main deck's (deck-copy.ts); everything here comes after them.
 * Figures are production only, dated on the slide: Base from D1, Monad read on chain. Change them only with a new read.
 * Source: the Whitechain plan in ottodevs/mamoru docs/ethglobal-mumbai/whitechain-gtm.md.
 */

export const WHITECHAIN = {
  title: "Mamoru × Whitechain",
  description: "Savings, automated. A go-to-market plan for Whitechain.",
  canonical: "https://mamoru.lol/deck/whitechain",
  traction: {
    eyebrow: "Live at ETHGlobal Mumbai",
    heading: ["Not an idea.", "A product people use."],
    figures: [
      { value: "57", label: "users" },
      { value: "4.2k", label: "USD of TVL across Base and Monad" },
      { value: "2", label: "chains live: Base and Monad" },
    ],
    note: "Mainnet, real funds. Production data on 6 Nov 2026, 23:10 UTC: Base from our database, Monad read on chain.",
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
    heading: "Who is already in.",
    rows: [
      {
        tag: "Onboarded",
        who: "Founders and builders",
        what: "In person, at Devcon and ETHGlobal Mumbai. They read the policy before they deposit.",
      },
      {
        tag: "Onboarded",
        who: "Known names in the ecosystem",
        what: "People others listen to. Their trust opens the door for everyone else.",
      },
      {
        tag: "Onboarded",
        who: "People who hold crypto",
        what: "Not natives, not known names: crypto sitting idle and no time to manage it. Where the volume is: your retail.",
      },
      {
        tag: "Next",
        who: "Yield seekers",
        what: "They want the yield without watching positions, ranges and gas every day.",
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
        proof: "Every user so far",
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
    heading: ["You have the liquidity.", "We bring the users."],
    lede: "A savings product on Whitechain gives WhiteBIT users a reason to move their capital from the exchange to your chain, and keep it there.",
    parts: [
      {
        who: "A product that brings users",
        what: "Mamoru on Whitechain: savings that run themselves, in the stablecoin you choose: USDT, EURC or USDC.",
      },
      {
        who: "From exchange to chain",
        what: "The easy path for WhiteBIT users to put their capital on Whitechain. Every deposit is liquidity on your chain.",
      },
      {
        who: "Help with the AMM",
        what: "More than 10 years in the sector. We can help you build the AMM the engine works on.",
      },
    ],
  },
  close: {
    eyebrow: "Next step",
    heading: ["Mamoru", "on Whitechain."],
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
