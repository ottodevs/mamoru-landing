/**
 * Terms, privacy and risks for mamoru.lol/terms, /privacy and /risks.
 * Shaped on the sector's usual documents (Uniswap, Aave, Morpho), written from what the code does:
 * the operator's session key, the data in D1, the two cookies, the providers. Change the code, change these.
 */

export type LegalDoc = {
  path: string;
  title: string;
  updated: string;
  summary: string;
  sections: ReadonlyArray<{ heading: string; body: ReadonlyArray<string> }>;
};

const UPDATED = "2 November 2026";

export const TERMS: LegalDoc = {
  path: "/terms",
  title: "Terms of Use",
  updated: UPDATED,
  summary:
    "These terms cover your use of mamoru.lol and the Mamoru app. Mamoru is an open-source project built by its contributors. It is not a company. By creating an account or using the app, you agree to these terms. If you do not agree, do not use Mamoru.",
  sections: [
    {
      heading: "What Mamoru is",
      body: [
        "Mamoru is software. It sets up a smart account that you own, and runs an automated operator that puts the funds in that account to work in on-chain liquidity positions and turns the yield into stablecoins.",
        "Mamoru is not a bank, a broker, an exchange or an investment adviser. It does not take custody of your funds, and nothing on mamoru.lol or in the app is financial, legal or tax advice.",
        "There is no company behind Mamoru today. It is built and run by a small group of contributors. On these pages, \"we\" means them.",
      ],
    },
    {
      heading: "Your account and your passkey",
      body: [
        "Your account is a Safe smart account on the blockchain. It is controlled by a passkey stored on your device and synced by Apple or Google. Mamoru never holds your passkey or any key that can move your funds out of your account.",
        "You are responsible for keeping your passkey and your devices safe. If you lose access to your passkey and its backup, Mamoru cannot recover it for you. Keep your recovery kit somewhere safe.",
      ],
    },
    {
      heading: "What the operator can and cannot do",
      body: [
        "When you start Mamoru, you sign a limited permission with your passkey. It lets the operator open, adjust and close liquidity positions and collect their fees, only through the contracts named in that permission.",
        "Every move the operator makes must return funds to your own account. Moves between chains may only arrive at your own account on the other chain. The operator cannot send your funds anywhere else. Only you, with your passkey, can withdraw or transfer funds out.",
        "While the product is young, Mamoru limits how much each account can hold.",
      ],
    },
    {
      heading: "Fees",
      body: [
        "Mamoru's fee is 10% of the yield harvested from your positions, never of your deposit. No yield, no fee. Today the fee is counted but not yet taken. Before it is taken, we will say so here and in the app.",
      ],
    },
    {
      heading: "No promise of returns",
      body: [
        "Rates shown on mamoru.lol and in the app are past averages or estimates. They are not a promise. You can earn less than shown, nothing, or lose part of your funds. Read the risks at mamoru.lol/risks before you deposit.",
      ],
    },
    {
      heading: "Who can use Mamoru",
      body: [
        "You must be at least 18 and able to enter into a binding agreement. You may not use Mamoru if you are the subject of sanctions, or if using it would break the laws that apply to you. You are responsible for any taxes on your activity.",
      ],
    },
    {
      heading: "Third-party protocols and services",
      body: [
        "Mamoru works on public blockchains and with protocols and services it does not control, such as Base, Uniswap, Safe and Circle. Their rules, fees, failures and changes are outside Mamoru's control.",
      ],
    },
    {
      heading: "Acceptable use",
      body: [
        "Do not use Mamoru for anything unlawful, do not try to break, overload or reverse-engineer the service beyond what its open-source licence allows, and do not use funds you are not entitled to.",
      ],
    },
    {
      heading: "Open-source software, provided as is",
      body: [
        "Mamoru's code is public under the MIT license at github.com/ottodevs/mamoru. The software and the service are provided as is, without warranties of any kind, to the extent the law allows.",
      ],
    },
    {
      heading: "You use Mamoru at your own risk",
      body: [
        "Mamoru is free, open-source software offered as is. You decide whether to use it, how much to deposit and when to withdraw. You use it entirely at your own risk.",
      ],
    },
    {
      heading: "No liability",
      body: [
        "To the fullest extent the law allows, Mamoru's contributors accept no liability of any kind for any loss or damage arising from your use of Mamoru, however it is caused. This includes loss of funds, lost yield or profits, and losses caused by smart contracts, blockchains, bridges, protocols, third-party services, market movements, the operator's decisions, or the loss of your passkey or devices.",
        "By using Mamoru, you agree not to bring any claim against its contributors for those losses, to the fullest extent the law allows.",
        "Nothing in these terms limits liability that the law does not allow to be limited.",
      ],
    },
    {
      heading: "Changes and pauses",
      body: [
        "We may change, pause or stop the service, or change these terms. We will post changes here with a new date. If Mamoru ever forms a company, these terms will say so. If the operator stops, your funds stay in your account, and you can still withdraw them with your passkey.",
      ],
    },
    {
      heading: "Contact",
      body: ["Questions about these terms: hi@mamoru.lol."],
    },
  ],
};

export const PRIVACY: LegalDoc = {
  path: "/privacy",
  title: "Privacy",
  updated: UPDATED,
  summary:
    "Mamoru is an open-source project run by its contributors, not a company. We keep as little about you as we can. No ads, no third-party analytics, nothing sold. This page lists what we keep and why.",
  sections: [
    {
      heading: "What we keep",
      body: [
        "Your account: the address of your smart account, the public key and ID of your passkey (never the passkey itself), the chains and positions it uses, and when it was created.",
        "Your balances and positions over time, to show you your history. These are already public on the blockchain.",
        "How often your account is used, counted by day.",
        "Feedback you send us, and a contact if you choose to add one.",
        "Your email, only if you write to us or join a list.",
      ],
    },
    {
      heading: "Cookies",
      body: [
        "The app sets one cookie to keep you signed in. Your device also remembers which passkey belongs to your account.",
        "mamoru.lol may set one random visitor ID to compare versions of the page. It is not set if your browser sends Do Not Track or Global Privacy Control.",
      ],
    },
    {
      heading: "Your IP address",
      body: [
        "We use it only to stop abuse, such as too many sign-ups or messages at once. We keep it only in hashed form, and only as long as that limit needs it.",
      ],
    },
    {
      heading: "Who else sees data",
      body: [
        "Cloudflare hosts mamoru.lol and the app and keeps short-lived request logs.",
        "Blockchain nodes (RPC providers) receive the requests needed to read and send transactions. Circle sees the transfers it handles when funds move between chains.",
        "Price and pool data providers receive no personal data.",
        "Feedback is shared with the contributors in our internal chat. Emails are sent through Loops.",
        "Anything done on a blockchain is public and permanent.",
      ],
    },
    {
      heading: "Your choices",
      body: [
        "Write to hi@mamoru.lol to see, correct or delete what we hold about you. We cannot delete anything that is on a blockchain.",
      ],
    },
    {
      heading: "Changes",
      body: ["If this changes, we will post it here with a new date."],
    },
  ],
};

export const RISKS: LegalDoc = {
  path: "/risks",
  title: "Risks",
  updated: UPDATED,
  summary:
    "Mamoru puts your funds to work in on-chain markets. That can earn yield, and it can lose money. You use Mamoru at your own risk, and its contributors accept no liability for losses (see the terms). Only deposit what you can afford to lose.",
  sections: [
    {
      heading: "Smart contracts",
      body: [
        "Your account, its modules and the protocols it uses are smart contracts. A bug or an exploit in any of them can lose funds.",
      ],
    },
    {
      heading: "Liquidity positions",
      body: [
        "Liquidity positions earn fees only while the price stays in their range. When prices move, a position can end up worth less than holding the same tokens. Fees can be lower than the cost of keeping a position in range.",
      ],
    },
    {
      heading: "Market prices",
      body: [
        "Part of your funds can be held in assets such as BTC or ETH, whose prices can fall fast.",
      ],
    },
    {
      heading: "Stablecoins",
      body: [
        "USDC is issued by Circle. A stablecoin can lose its peg, or be frozen by its issuer.",
      ],
    },
    {
      heading: "Blockchains and bridges",
      body: [
        "Networks can stop, slow down or get congested. Moving funds between chains can take time, and a transfer can be delayed or get stuck.",
      ],
    },
    {
      heading: "Automation",
      body: [
        "Mamoru's operator is software. It can act late, not act, or make a move that turns out badly. Its permission is limited to your own account, but its decisions can still lose money.",
      ],
    },
    {
      heading: "Your passkey",
      body: [
        "Only your passkey can move funds out. If you lose it and its backup, your funds can become impossible to reach.",
      ],
    },
    {
      heading: "Rates are not promises",
      body: [
        "Rates shown are past averages or estimates. Future yield can be lower, zero or negative.",
      ],
    },
    {
      heading: "No insurance",
      body: [
        "Funds in Mamoru are not covered by deposit insurance or any guarantee scheme.",
      ],
    },
    {
      heading: "A small project, no company",
      body: [
        "Mamoru is run by a small group of contributors, with no company behind it. Development or the operator can stop. If that happens, your funds stay in your account and you can withdraw them with your passkey.",
      ],
    },
    {
      heading: "Early product, changing rules",
      body: [
        "Mamoru is new, and limits how much each account can hold. Laws about digital assets change and may affect how you can use it.",
      ],
    },
  ],
};
