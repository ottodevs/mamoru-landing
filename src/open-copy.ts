/**
 * Copy for the page that replaces the countdown.
 * One place to edit the words. APP_HREF is the only "Open app" target.
 * A hash keeps the click on this page. A URL leaves it.
 */

export const APP_HREF = "https://app.mamoru.lol";

export const OPEN_COPY = {
  title: "Mamoru",
  description: "The principal keeps working. The yield gets set aside.",
  nav: [
    { href: "#works", label: "How it works" },
    { href: "#questions", label: "FAQs" },
  ],
  cta: "Launch APP",
  hero: {
    line1: "APY.",
    line2: "DELIVERED.",
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
  },
  spend: {
    heading: "DeFi yields you can actually spend",
    body: "No more endless autocompounding that leaves you with no real value. Mamoru captures raw DeFi yield, converts it to stablecoins, and sends it to your pocket while your principal works.",
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
      {
        q: "How do I reach you?",
        a: [],
        reach: [
          { label: "hi@mamoru.lol", href: "mailto:hi@mamoru.lol" },
          { label: "X @entermamoru", href: "https://x.com/entermamoru" },
        ],
      },
    ],
  },
  footer: {
    name: "Mamoru",
    line: "Non-custodial. No token.",
    email: "hi@mamoru.lol",
  },
} as const;
