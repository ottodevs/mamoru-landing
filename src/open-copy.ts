/**
 * Copy for the page that replaces the countdown.
 * One place to edit the words. APP_HREF is the only "Open app" target.
 * A hash keeps the click on this page. A URL leaves it.
 */

export const APP_HREF = "https://app.mamoru.lol";

const MIX = [
  {
    pct: 15,
    name: "Mercenary Capital",
    note: "High risk, high reward",
    tone: "mercenary",
  },
  {
    pct: 35,
    name: "BTC / ETH + Stablecoins",
    note: "Derivatives paired with stablecoins",
    tone: "paired",
  },
  {
    pct: 50,
    name: "Stablecoins",
    note: "Liquidity, yield and market depth.",
    tone: "stables",
  },
] as const;

export const OPEN_COPY = {
  title: "Mamoru",
  description: "The principal keeps working. Yield is reinvested until you transfer.",
  nav: [
    { href: "#works", label: "How it works" },
    { href: "#questions", label: "FAQs" },
  ],
  cta: "Launch APP",
  onboard: {
    storageKey: "mamoru-onboarded-v4",
    skip: "Skip",
    next: "Next",
    finish: "Finish",
    mix: MIX,
    screens: [
      {
        title: "Fund Mamoru",
        body: ["Send the ETH you want to invest."],
        mix: false,
      },
      {
        title: "What's next?",
        body: [
          "Yield is reinvested. You can transfer part or all of it whenever you want.",
        ],
        mix: false,
      },
      {
        title: "You keep control",
        body: [
          "No forced lockups or third-party dependencies.",
          "Free to exit anytime.",
        ],
        mix: false,
      },
    ],
  },
  hero: {
    line1: "APY",
    line2: "DELIVERED",
    lede: "The principal keeps working. Yield is reinvested until you transfer.",
  },
  works: {
    heading: "How it works",
    moves: [
      {
        title: "Connect",
        body: "Connect your wallet in one click or log in with your email. Mamoru sets up a dedicated sub-account for your agent.",
      },
      {
        title: "Fund",
        body: "Deposit the ETH you want to put to work. The agent operates programmatically with that capital, leaving your main wallet untouched.",
      },
      {
        title: "Allocate",
        body: "Mamoru splits the capital into three sleeves on Uniswap: stablecoins, bluechips, and a small mercenary sleeve.",
      },
      {
        title: "Harvest",
        body: "Yield is harvested and reinvested. It stays at work until you transfer.",
      },
    ],
    scene: {
      wallet: "Your wallet",
      agent: "Mamoru Delegated Account",
      strategy: "Funds Allocation",
      payout: "Stablecoin pool",
      eth: "ETH",
      usdc: "USDC",
      key: "Session key: Uniswap only",
      sleeves: ["Stables", "Bluechips", "Mercenary"],
      swap: "Quote, swap, LP",
      fees: "+ fees",
      reinvest: "Reinvested",
      withdraw: "Withdraw any time. Stablecoins pay first.",
      rebalance: "Rebalanced",
      aria: "ETH funds the Mamoru Delegated Account. Mamoru splits it into stablecoin, bluechip and mercenary sleeves on Uniswap. Fees land in the stablecoin pool and are reinvested. You can withdraw any time: stablecoins pay first, then the sleeves rebalance.",
    },
  },
  spend: {
    heading: "DeFi yield for the real world",
    body: "Yield comes back as stablecoins and is reinvested. Transfer it to your account whenever you want.",
  },
  allocation: {
    eyebrow: "Portfolio allocation",
    heading: ["Three assets.", "One allocation."],
    body: "A diversified allocation designed to capture yield.",
    mix: MIX,
  },
  questions: {
    heading: "FAQs",
    items: [
      {
        q: "Who holds the money?",
        a: ["You do. It sits in a smart account under your control. Mamoru does not take custody."],
      },
      {
        q: "Where does a position live?",
        a: ["On Uniswap. Mamoru quotes, opens, and adjusts positions there transparently."],
      },
      {
        q: "When do funds leave?",
        a: [
          "When you transfer. Part or all of the funds leave the allocations and go to your account. Until then, yield is reinvested.",
        ],
      },
      {
        q: "Can I withdraw my funds at any time?",
        a: [
          "Yes. There is no lockup. Transfer part or all of it to your account whenever you want.",
        ],
      },
      {
        q: "Is there a token?",
        a: ["No."],
      },
      {
        q: "What happens to the email I used to log in?",
        a: [
          "It stays strictly with us for account access. We never rent or sell lists, and we hate spam as much as you do.",
          "It stays with us. We do not rent the list, and we do not send anything else.",
        ],
      },
    ],
  },
  footer: {
    name: "Mamoru",
    line: "Non-custodial. No token.",
    email: "hi@mamoru.lol",
    x: { handle: "@entermamoru", href: "https://x.com/entermamoru" },
  },
} as const;
