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
    note: "Bluechips paired with stablecoins",
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
  description: "The principal keeps working. The yield becomes stablecoins.",
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
    lede: "The principal keeps working. The yield becomes stablecoins.",
  },
  works: {
    eyebrow: "How it works",
    heading: "One simple loop.",
    moves: [
      { title: "Fund", body: "You put capital to work." },
      { title: "Mamoru works", body: "Your capital works automatically." },
      { title: "You save", body: "Your yield becomes stablecoins." },
    ],
    scene: {
      coin: "USDC",
      aria: "You fund Mamoru. Your capital parts into three working positions. Their yield flows out, becomes USDC and returns to the stablecoin position, which grows and keeps working.",
    },
  },
  spend: {
    heading: "DeFi yield for the real world",
    body: "Yield comes back as stablecoins and is reinvested. Transfer it to your account whenever you want.",
  },
  // The landing's how-it-works v4 (Brais, 27 Oct): one deposit of USDC on Base rises into the column, which parts into
  // three positions; their yield is captured in Stables. The messages are HTML over the loop, on its clock (seconds).
  flow: {
    eyebrow: "How it works",
    messages: [
      { at: 0.4, out: 4.9, lines: ["You bring", "the capital."] },
      { at: 5.2, out: 8.4, lines: ["Mamoru puts it", "all to work."] },
      { at: 8.8, out: 11.7, lines: ["Yield, captured", "in stablecoins."] },
    ],
    aria: "One deposit of USDC on Base enters Mamoru and rises into one column, which parts into three positions: 15% Growth, 35% Balance and 50% Stables. The yield of Growth and Balance is captured in Stables.",
  },
  // Slide 3 v3 (Penpot "Mamoru — Slide 3 -v3 pools"): top to bottom, as the column reads.
  allocation: {
    eyebrow: "Portfolio allocation",
    heading: ["Three positions.", "One growing reserve."],
    body: "Capital works. The yield is captured in stablecoins.",
    note: "Half in stablecoins by rule",
    mix: [
      { pct: 15, name: "Growth", tone: "growth" },
      { pct: 35, name: "Balance", tone: "balance" },
      { pct: 50, name: "Stables", tone: "stables" },
    ],
  },
  questions: {
    heading: "FAQs",
    items: [
      {
        q: "How do I start?",
        a: ["Approve two signatures with your passkey, then add USDC on Base. Mamoru starts on its own."],
        watch: { id: "walkthrough", label: "Watch the walkthrough", length: "1:18" },
      },
      {
        q: "Who holds the money?",
        a: ["You do. It sits in a smart account under your control. Mamoru does not take custody."],
      },
      {
        q: "Where does a position live?",
        a: ["On Uniswap. Mamoru quotes, opens, and adjusts positions there transparently."],
      },
      {
        q: "Who can withdraw funds?",
        a: ["Only you, with your passkey."],
      },
      {
        q: "Can I withdraw my funds at any time?",
        a: [
          "Yes. There is no lockup. Transfer part or all of it to your account whenever you want.",
        ],
      },
      {
        q: "What if I lose the device with my passkey?",
        a: [
          "Your passkey syncs with your Apple or Google account, so a new phone opens the same account. Back it up as soon as you create your account.",
        ],
        watch: { id: "passkey", label: "Watch: your passkey", length: "1:02" },
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
    ],
  },
  footer: {
    name: "Mamoru",
    line: "Non-custodial. No token.",
    email: "hi@mamoru.lol",
    x: { handle: "@entermamoru", href: "https://x.com/entermamoru" },
  },
} as const;
