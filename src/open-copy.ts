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
  description: "The principal keeps working. The yield gets set aside.",
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
        title: "What happens next?",
        body: [
          "Mamoru applies a conservative allocation of 50%-35%-15% and will send USDC to a wallet of your choice.",
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
    lede: "The principal keeps working. The yield gets set aside.",
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
        title: "Harvest",
        body: "Yield is automatically harvested from the pools, converted to USDC, and sent straight to the wallet of your choice.",
      },
    ],
    scene: {
      wallet: "Your wallet",
      agent: "Agent account",
      strategy: "Strategy",
      payout: "Wallet of your choice",
      eth: "ETH",
      usdc: "USDC",
      aria: "ETH funds the agent once, then the strategy. USDC keeps harvesting to a wallet of your choice.",
    },
  },
  spend: {
    heading: "DeFi yield for the real world",
    body: "No more yield that just keeps stacking onchain. Mamoru turns your DeFi yield into stablecoins you can actually use while your principal keeps working.",
  },
  allocation: {
    eyebrow: "Portfolio allocation",
    heading: ["Three assets.", "One Strategy."],
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
        q: "What gets set aside?",
        a: ["Only realized yield. Your principal stays dedicated to generating returns."],
      },
      {
        q: "Can I withdraw my funds at any time?",
        a: [
          "Yes. There are no lockup periods. You can pause the agent anytime or exit the pools and withdraw your principal or stablecoin earnings whenever you want.",
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
