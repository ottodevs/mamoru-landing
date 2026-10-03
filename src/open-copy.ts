/**
 * Copy for the page that replaces the countdown.
 * One place to edit the words. APP_HREF is the only "Open app" target.
 * A hash keeps the click on this page. A URL leaves it.
 */

export const APP_HREF = "https://app.mamoru.lol";

const MIX = [
  {
    pct: 10,
    name: "Mercenary Capital",
    note: "High risk, high reward",
    tone: "mercenary",
  },
  {
    pct: 40,
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
  description: "The principal keeps working. You collect stablecoins.",
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
    line1: "SAVINGS,",
    line2: "AUTOMATED",
    lede: "The principal keeps working. You collect stablecoins.",
  },
  works: {
    heading: "How it works",
    moves: [
      {
        title: "Your money goes in",
        body: "It lands in an account only you control. Mamoru never holds it.",
      },
      {
        title: "It goes to work",
        body: "Mamoru spreads it across three pools on Uniswap and looks after them for you.",
      },
      {
        title: "The earnings are set aside",
        body: "What your money earns is kept in stablecoins, ready to collect whenever you want.",
      },
    ],
    scene: {
      agent: "Your account",
      strategy: "Three pools",
      payout: "Stablecoins",
      pond: "Stablecoins",
      fees: "+ earnings",
      collect: "Collect any time",
      aria: "Your money goes into an account you control. Mamoru spreads it across three pools on Uniswap. What it earns is set aside in stablecoins, and you can collect it any time.",
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
        q: "How much does Mamoru cost?",
        a: [
          "Nothing upfront. We take 10% of the yield you harvest to cover account maintenance and gas. No yield, no fee.",
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
