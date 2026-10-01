/**
 * Base mainnet constants for the Infra panel. Addresses only, no secrets.
 * Matches the live registry in ottodevs/mamoru (packages/registry/base.json).
 */

export const CHAIN_ID = 8453;

/** The operator's relayer EOA. Pays Safe deploys, activations, and top-ups. */
export const RELAYER_ADDRESS = "0x8F7D5E4F206a91c58132b8f88c629b45d8dcb5A0";

export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const UNISWAP_V3_FACTORY = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD";
export const NONFUNGIBLE_POSITION_MANAGER = "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1";

export const WETH_ADDRESS = "0x4200000000000000000000000000000000000006";
export const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const CBBTC_ADDRESS = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
export const USDBC_ADDRESS = "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA";
export const USDT_ADDRESS = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2";
export const DAI_ADDRESS = "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb";

/** Fee tier used to read the reference price for each priced token. */
export const USDC_WETH_FEE = 500;
export const USDC_CBBTC_FEE = 500;

export type TokenMeta = { symbol: string; decimals: number };

/** Known Base tokens the Infra panel can price. Unknown tokens show raw units only. */
export const KNOWN_TOKENS: Readonly<Record<string, TokenMeta>> = {
  [USDC_ADDRESS.toLowerCase()]: { symbol: "USDC", decimals: 6 },
  [USDBC_ADDRESS.toLowerCase()]: { symbol: "USDbC", decimals: 6 },
  [USDT_ADDRESS.toLowerCase()]: { symbol: "USDT", decimals: 6 },
  [DAI_ADDRESS.toLowerCase()]: { symbol: "DAI", decimals: 18 },
  [WETH_ADDRESS.toLowerCase()]: { symbol: "WETH", decimals: 18 },
  [CBBTC_ADDRESS.toLowerCase()]: { symbol: "cbBTC", decimals: 8 },
};

const STABLE_ADDRESSES = new Set(
  [USDC_ADDRESS, USDBC_ADDRESS, USDT_ADDRESS, DAI_ADDRESS].map((a) => a.toLowerCase()),
);

export function isStable(address: string): boolean {
  return STABLE_ADDRESSES.has(address.toLowerCase());
}

export function tokenMeta(address: string): TokenMeta | null {
  return KNOWN_TOKENS[address.toLowerCase()] ?? null;
}

/**
 * Public Base RPCs, tried in order. `BASE_RPC_URL` (secret, optional) goes first
 * when set. The chosen URL is never sent to the browser or logged.
 */
export function rpcUrls(secretFirst?: string): string[] {
  const list = [
    "https://base-rpc.publicnode.com",
    "https://base.drpc.org",
    "https://mainnet.base.org",
  ];
  return secretFirst ? [secretFirst, ...list] : list;
}

/** Public, non-secret endpoint used only for the wallet's "Add Base Network" prompt. */
export const WALLET_ADD_CHAIN_RPC = "https://mainnet.base.org";

export function basescanAddress(address: string): string {
  return `https://basescan.org/address/${address}`;
}

export function basescanTx(hash: string): string {
  return `https://basescan.org/tx/${hash}`;
}
