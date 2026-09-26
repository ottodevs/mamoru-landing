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
    { href: "#split", label: "The split" },
    { href: "#works", label: "How it works" },
    { href: "#questions", label: "Questions" },
  ],
  cta: "Open app",
  hero: {
    line1: "APY.",
    line2: "DELIVERED.",
    lede: "The principal keeps working. The yield gets set aside.",
  },
  split: {
    heading: "Two places.",
    principal: {
      name: "The principal",
      body: "It stays in your account and keeps working.",
    },
    yield: {
      name: "The yield",
      body: "Only what has been realized is set aside.",
    },
  },
  works: {
    heading: "How it works",
    moves: [
      {
        title: "Recover access first.",
        body: "You can get back in before anything is deposited.",
      },
      {
        title: "The account is yours.",
        body: "Capital sits in a smart account you control. Mamoru does not hold it.",
      },
      {
        title: "Uniswap is the venue.",
        body: "Quotes, swaps, and liquidity positions. Nothing else.",
      },
      {
        title: "Yield is what gets saved.",
        body: "When it is realized, that part is set aside. The principal stays at work.",
      },
    ],
    plain: "No Mamoru token. No promised rate.",
  },
  questions: {
    heading: "Questions",
    items: [
      {
        q: "Who holds the money?",
        a: "You do. It sits in a smart account under your control. Mamoru does not take custody.",
      },
      {
        q: "What gets set aside?",
        a: "Only realized yield. The principal is not moved into savings.",
      },
      {
        q: "Where does a position live?",
        a: "On Uniswap. Mamoru quotes, opens, and adjusts there.",
      },
      {
        q: "Is there a token?",
        a: "No.",
      },
      {
        q: "What happens to an email I already left?",
        a: "It stays with us. We do not rent the list, and we do not send anything else.",
      },
      {
        q: "How do I reach you?",
        a: "hi@mamoru.lol",
      },
    ],
  },
  enter: {
    heading: "Your account",
    body: "Recover access before you deposit. The principal works in your account.",
  },
  footer: {
    name: "Mamoru",
    line: "Non-custodial. No token.",
    email: "hi@mamoru.lol",
  },
} as const;
