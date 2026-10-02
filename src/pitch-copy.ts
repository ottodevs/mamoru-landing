/**
 * Words for mamoru.lol/pitch. Slides guide, the speaker tells.
 */

export const PITCH = {
  title: "Mamoru · Pitch",
  description: "Savings on Uniswap where the only key that can pay out is yours.",
  key: {
    heading: ["This key", "just leaked."],
    lede: "It is the key Mamoru's engine uses to move the money in this account. Scan it. It is yours.",
    href: "https://app.mamoru.lol/lab",
    hrefLabel: "app.mamoru.lol/lab",
  },
  attacks: {
    eyebrow: "Try to rob it",
    heading: "Four ways to take the money.",
    attempts: [
      { ask: "Send the dollars to my wallet.", verdict: "REFUSED", why: "the key cannot call a transfer" },
      { ask: "Swap them, and send what comes out to me.", verdict: "REFUSED", why: "the only recipient is the account" },
      { ask: "Approve me to spend everything.", verdict: "REFUSED", why: "no approval beyond the trade" },
      { ask: "Make me an owner.", verdict: "REFUSED", why: "the key cannot touch the account itself" },
    ],
    foot: "Leaked-key attacks, replayed on a fork of Base. The chain refuses them all.",
  },
  owner: {
    eyebrow: "Who can",
    heading: ["One signature.", "Yours."],
    points: [
      "Transfer out anytime, to any wallet.",
      "Stop, and everything comes back to dollars in your account.",
      "Signed with the passkey on your device. Mamoru never holds it.",
    ],
    href: "https://app.mamoru.lol",
    hrefLabel: "app.mamoru.lol",
  },
  leave: {
    eyebrow: "And if we disappear",
    heading: ["You leave", "without us."],
    points: [
      "A recovery kit, saved before your first deposit.",
      "It rebuilds your account with our servers off.",
      "Revoke the engine, close the positions, take the money.",
    ],
  },
  modules: {
    uniswap: {
      eyebrow: "Uniswap",
      heading: "Every move is a Uniswap call.",
      points: [
        "Swaps through SwapRouter02, with a quoted minimum on every one.",
        "Liquidity through the position manager: mint, collect, close.",
        "The engine key is limited to those calls, on those contracts.",
        "Transfer out in dollars, euros or ether, swapped on the way.",
      ],
    },
    curvegrid: {
      eyebrow: "Curvegrid",
      heading: "Every number shows where it came from.",
      points: [
        "Pool history indexed by Curvegrid MultiBaas.",
        "Each row checked against Base before it is shown.",
        "Source and block on every figure.",
      ],
    },
    intercepta: {
      eyebrow: "Mamoru San · x402",
      heading: "Agents pay agents. Ours checks first.",
      points: [
        "Every x402 payment is screened by Intercepta before it is signed, and before it is accepted.",
        "The honest seller gets paid.",
        "The sanctioned payee gets no signature.",
      ],
    },
  },
  close: {
    caption: "守る · to protect",
    heading: ["The only key that pays out", "is yours."],
    lede: "Savings on Uniswap, on Base.",
    cta: "Try to rob it",
    href: "https://app.mamoru.lol/lab",
    hrefLabel: "app.mamoru.lol/lab",
    next: "Next stop: Mumbai.",
    links: [
      { label: "mamoru.lol", href: "https://mamoru.lol" },
      { label: "github.com/ottodevs/mamoru", href: "https://github.com/ottodevs/mamoru" },
      { label: "@entermamoru", href: "https://x.com/entermamoru" },
    ],
  },
} as const;

export type PitchModule = keyof typeof PITCH.modules;
