/**
 * Funding targets for /ops (otto/mamoru-astro#27): every wallet the system spends from, on every chain it runs on.
 * One list so a new chain or wallet is one more entry. Addresses and public endpoints only, no secrets.
 * Balances are read server-side with plain JSON-RPC; one chain failing never hides the others.
 */

import { RELAYER_ADDRESS, WALLET_ADD_CHAIN_RPC } from "./chain-addresses";
import type { TopupChain } from "./topup-logic";

export type FundingStatus = "ok" | "low" | "empty" | "unknown";

export interface FundingChain extends TopupChain {
  chainId: number;
  /** Public RPC the wallet is offered when it does not know the chain, and the server reads with. */
  rpc: string;
  explorerAddress: string;
  explorerUrl: string;
}

export interface FundingTarget {
  id: string;
  /** Short name in the list: "Relayer on Monad". */
  label: string;
  /** As said in sentences by the widget. */
  recipientName: string;
  address: string;
  chain: FundingChain;
  /** What the funds pay for, one sentence. */
  pays: string;
  /** Below this the wallet is "low", in wei. */
  lowWei: bigint;
  /** Amount buttons, in the native asset. */
  presets: string[];
  /** Price the native asset with the ETH price (true only for ETH). */
  priceAsEth: boolean;
  /** Ticket that is waiting on this wallet, when one is. */
  ticket?: { label: string; href: string };
}

const E18 = 10n ** 18n;
const milli = (n: number) => (BigInt(n) * E18) / 1000n;

export const BASE: FundingChain = {
  chainId: 8453,
  hex: "0x2105",
  name: "Base",
  symbol: "ETH",
  explorerTx: "https://basescan.org/tx/",
  explorerName: "Basescan",
  l1FeeMarginWei: "2000000000000",
  rpc: WALLET_ADD_CHAIN_RPC,
  explorerAddress: "https://basescan.org/address/",
  explorerUrl: "https://basescan.org",
};

export const MONAD: FundingChain = {
  chainId: 143,
  hex: "0x8f",
  name: "Monad",
  symbol: "MON",
  explorerTx: "https://monadscan.com/tx/",
  explorerName: "Monadscan",
  rpc: "https://rpc.monad.xyz",
  explorerAddress: "https://monadscan.com/address/",
  explorerUrl: "https://monadscan.com",
};

export const ETHEREUM: FundingChain = {
  chainId: 1,
  hex: "0x1",
  name: "Ethereum",
  symbol: "ETH",
  explorerTx: "https://etherscan.io/tx/",
  explorerName: "Etherscan",
  rpc: "https://ethereum-rpc.publicnode.com",
  explorerAddress: "https://etherscan.io/address/",
  explorerUrl: "https://etherscan.io",
};

const FORGEJO = "https://git.ot2.me/otto/mamoru/issues/";

/** The same relayer key signs on every chain, so the address is the same; the funds are not. */
export const FUNDING_TARGETS: readonly FundingTarget[] = [
  {
    id: "relayer-base",
    label: "Relayer on Base",
    recipientName: "the relayer",
    address: RELAYER_ADDRESS,
    chain: BASE,
    pays: "Safe deploys, activations and each new account's gas reserve on Base.",
    lowWei: milli(5),
    presets: ["0.005", "0.01", "0.02"],
    priceAsEth: true,
  },
  {
    id: "relayer-monad",
    label: "Relayer on Monad",
    recipientName: "the relayer on Monad",
    address: RELAYER_ADDRESS,
    chain: MONAD,
    pays: "Activations on Monad, about 1.4 MON each at today's gas. Monad cannot start without it.",
    lowWei: 5n * E18,
    presets: ["5", "10", "25"],
    priceAsEth: false,
    ticket: { label: "otto/mamoru#68", href: FORGEJO + "68" },
  },
  {
    id: "relayer-ethereum",
    label: "Relayer on Ethereum",
    recipientName: "the relayer on Ethereum",
    address: RELAYER_ADDRESS,
    chain: ETHEREUM,
    pays: "Deploying the owner's Safe on Ethereum to move USDC sent there back to Base.",
    lowWei: milli(3),
    presets: ["0.002", "0.005", "0.01"],
    priceAsEth: true,
    ticket: { label: "otto/mamoru#180", href: FORGEJO + "180" },
  },
];

export function fundingStatus(balanceWei: bigint | null, lowWei: bigint): FundingStatus {
  if (balanceWei === null) return "unknown";
  if (balanceWei === 0n) return "empty";
  return balanceWei < lowWei ? "low" : "ok";
}

export interface FundingRow {
  target: FundingTarget;
  balanceWei: bigint | null;
  status: FundingStatus;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** eth_getBalance over plain JSON-RPC, with a short timeout. null when the chain does not answer. */
export async function readBalance(chain: FundingChain, address: string, fetchFn: Fetch = fetch, timeoutMs = 4000): Promise<bigint | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchFn(chain.rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }),
      signal: ctl.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: unknown };
    return typeof body.result === "string" && /^0x[0-9a-f]+$/i.test(body.result) ? BigInt(body.result) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Every target with its balance. `known` carries balances the caller already read (the Base relayer is read by the
 * infra snapshot with its keyed RPC); those are not read twice.
 */
export async function readFunding(known: Partial<Record<string, bigint | null>> = {}, fetchFn: Fetch = fetch): Promise<FundingRow[]> {
  return Promise.all(
    FUNDING_TARGETS.map(async (target) => {
      const balanceWei = target.id in known ? (known[target.id] ?? null) : await readBalance(target.chain, target.address, fetchFn);
      return { target, balanceWei, status: fundingStatus(balanceWei, target.lowWei) };
    }),
  );
}

/** What the browser widget needs per target. Strings only: it is serialized into a data attribute. */
export function widgetTarget(row: FundingRow) {
  const t = row.target;
  return {
    id: t.id,
    label: t.label,
    recipientName: t.recipientName,
    address: t.address,
    chain: {
      hex: t.chain.hex,
      name: t.chain.name,
      symbol: t.chain.symbol,
      explorerTx: t.chain.explorerTx,
      explorerName: t.chain.explorerName,
      ...(t.chain.l1FeeMarginWei ? { l1FeeMarginWei: t.chain.l1FeeMarginWei } : {}),
      // Only for chains a wallet may not know yet; Ethereum is always there, and keyless public RPCs stay off pages otherwise.
      ...(t.chain.chainId === 1 ? {} : { rpc: t.chain.rpc }),
      explorerUrl: t.chain.explorerUrl,
    },
    presets: t.presets,
    priceAsEth: t.priceAsEth,
  };
}
