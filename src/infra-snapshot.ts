/**
 * Builds the whole /ops/infra snapshot: relayer status, cost-per-account at the
 * current Base gas price, and accounts + TVL from D1 plus on-chain reads.
 * Every on-chain section degrades to an error note instead of throwing; D1 and
 * RPC failures are independent, so one can work while the other does not.
 */

import type { Address } from "viem";
import {
  type BaseClient,
  type ContractCall,
  buildClient,
  multi,
} from "./chain-client";
import {
  erc20Abi,
  multicall3Abi,
  positionManagerAbi,
  uniswapV3FactoryAbi,
  uniswapV3PoolAbi,
} from "./chain-abi";
import {
  CBBTC_ADDRESS,
  CHAIN_ID,
  MULTICALL3_ADDRESS,
  NONFUNGIBLE_POSITION_MANAGER,
  RELAYER_ADDRESS,
  UNISWAP_V3_FACTORY,
  USDC_ADDRESS,
  USDC_CBBTC_FEE,
  USDC_WETH_FEE,
  WETH_ADDRESS,
  basescanAddress,
  isStable,
  tokenMeta,
} from "./chain-addresses";
import {
  accountsFunded,
  costPerAccount,
  ethToUsd,
  relayerStatus,
  type RelayerStatus,
  unitsToNumber,
  weiToEth,
} from "./cost";
import { type PoolState, priceOfBaseInQuote, sameAddress, valuePosition } from "./uniswap-math";
import { type AccountRow, type D1Db, fetchChainAccounts, fetchInfraCounts } from "./d1-infra";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function isZeroAddress(address: string): boolean {
  return address.toLowerCase() === ZERO_ADDRESS;
}

function shortKey(key: string): string {
  return key.length <= 10 ? key : `${key.slice(0, 8)}…`;
}

interface Prices {
  ethUsd: number | null;
  btcUsd: number | null;
}

export interface RelayerView {
  address: string;
  basescanUrl: string;
  ethBalance: number;
  usd: number | null;
  status: RelayerStatus;
}

export interface CostView {
  gasPriceGwei: number;
  deployEth: number;
  deployUsd: number | null;
  activationEth: number;
  activationUsd: number | null;
  reserveEth: number;
  reserveUsd: number | null;
  totalEth: number;
  totalUsd: number | null;
  /** Exact total in wei, as a decimal string: the top-up widget does integer math with it. */
  totalWei?: string;
  accountsFunded: number;
}

export interface AccountView {
  accountKey: string;
  address: string;
  basescanUrl: string;
  ethBalance: number;
  usdcIdle: number;
  lpUsd: number;
  positions: number;
  inRange: number;
  /** True when a read this account's value depends on failed. Its numbers are then a floor, not a total. */
  unread?: boolean;
}

export type UnreadPart = "prices" | "balances" | "positions" | "pools";

/** Set when some reads failed after one retry. Totals built from this snapshot are incomplete. */
export interface PartialRead {
  unreadAccounts: number;
  parts: UnreadPart[];
}

export interface AccountsView {
  totalUsers: number;
  totalAccounts: number;
  last7d: number;
  rows: AccountView[];
  tvlUsd: number;
  idleUsdcUsd: number;
  lpUsd: number;
  gasReservesEth: number;
  error?: string;
  /** Accounts whose value could not be fully read. */
  unreadAccounts?: number;
  unreadParts?: UnreadPart[];
}

export interface InfraSnapshot {
  asOf: string;
  rpcError?: string;
  partial?: PartialRead;
  ethUsd: number | null;
  btcUsd: number | null;
  relayer: RelayerView | null;
  cost: CostView | null;
  accounts: AccountsView | null;
}

export interface InfraEnv {
  BASE_RPC_URL?: string;
  MAMORU_DB?: D1Db;
}

export function decimalsOf(address: string): number {
  return tokenMeta(address)?.decimals ?? 18;
}

export function priceUsdOf(prices: Prices | null, token: string): number | null {
  if (isStable(token)) return 1;
  if (!prices) return null;
  if (sameAddress(token, WETH_ADDRESS)) return prices.ethUsd;
  if (sameAddress(token, CBBTC_ADDRESS)) return prices.btcUsd;
  return null;
}

function ethBalanceCall(address: string): ContractCall {
  return {
    address: MULTICALL3_ADDRESS as Address,
    abi: multicall3Abi,
    functionName: "getEthBalance",
    args: [address],
  };
}

function usdcBalanceCall(address: string): ContractCall {
  return { address: USDC_ADDRESS as Address, abi: erc20Abi, functionName: "balanceOf", args: [address] };
}

function npmBalanceCall(address: string): ContractCall {
  return {
    address: NONFUNGIBLE_POSITION_MANAGER as Address,
    abi: positionManagerAbi,
    functionName: "balanceOf",
    args: [address],
  };
}

function tokenOfOwnerByIndexCall(owner: string, index: number): ContractCall {
  return {
    address: NONFUNGIBLE_POSITION_MANAGER as Address,
    abi: positionManagerAbi,
    functionName: "tokenOfOwnerByIndex",
    args: [owner, BigInt(index)],
  };
}

function positionsCall(tokenId: bigint): ContractCall {
  return {
    address: NONFUNGIBLE_POSITION_MANAGER as Address,
    abi: positionManagerAbi,
    functionName: "positions",
    args: [tokenId],
  };
}

function getPoolCall(token0: string, token1: string, fee: number): ContractCall {
  return {
    address: UNISWAP_V3_FACTORY as Address,
    abi: uniswapV3FactoryAbi,
    functionName: "getPool",
    args: [token0, token1, fee],
  };
}

function slot0Call(pool: string): ContractCall {
  return { address: pool as Address, abi: uniswapV3PoolAbi, functionName: "slot0" };
}

async function resolveReferencePools(
  client: BaseClient,
): Promise<{ weth: string | null; cbbtc: string | null }> {
  const [wethPool, cbbtcPool] = await multi(client, [
    getPoolCall(USDC_ADDRESS, WETH_ADDRESS, USDC_WETH_FEE),
    getPoolCall(USDC_ADDRESS, CBBTC_ADDRESS, USDC_CBBTC_FEE),
  ]);
  const weth = typeof wethPool === "string" && !isZeroAddress(wethPool) ? wethPool : null;
  const cbbtc = typeof cbbtcPool === "string" && !isZeroAddress(cbbtcPool) ? cbbtcPool : null;
  return { weth, cbbtc };
}

async function resolvePrices(
  client: BaseClient,
  pools: { weth: string | null; cbbtc: string | null },
): Promise<Prices> {
  const calls: ContractCall[] = [];
  if (pools.weth) calls.push(slot0Call(pools.weth));
  if (pools.cbbtc) calls.push(slot0Call(pools.cbbtc));
  const results = await multi(client, calls);
  let cursor = 0;
  const wethSlot0 = pools.weth ? (results[cursor++] as readonly [bigint, number] | undefined) : undefined;
  const cbbtcSlot0 = pools.cbbtc ? (results[cursor++] as readonly [bigint, number] | undefined) : undefined;
  const ethUsd = wethSlot0
    ? priceOfBaseInQuote({
        sqrtPriceX96: wethSlot0[0],
        base: WETH_ADDRESS,
        quote: USDC_ADDRESS,
        decimalsOf,
      })
    : null;
  const btcUsd = cbbtcSlot0
    ? priceOfBaseInQuote({
        sqrtPriceX96: cbbtcSlot0[0],
        base: CBBTC_ADDRESS,
        quote: USDC_ADDRESS,
        decimalsOf,
      })
    : null;
  return { ethUsd, btcUsd };
}

type RawPosition = readonly [
  bigint,
  string,
  string,
  string,
  number,
  number,
  number,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
];

const poolKey = (token0: string, token1: string, fee: number) =>
  `${token0.toLowerCase()}:${token1.toLowerCase()}:${fee}`;

interface Valued {
  rows: AccountView[];
  unreadAccounts: number;
  parts: Set<UnreadPart>;
}

/**
 * Balances and LP value per account. A read that fails (after multi()'s one retry)
 * marks its account `unread` and names the part that failed; nothing is counted as zero.
 */
async function valueAccounts(
  client: BaseClient,
  accounts: AccountRow[],
  prices: Prices | null,
): Promise<Valued> {
  const parts = new Set<UnreadPart>();
  if (accounts.length === 0) return { rows: [], unreadAccounts: 0, parts };
  const unread = new Set<number>();
  const miss = (accountIndex: number, part: UnreadPart) => {
    unread.add(accountIndex);
    parts.add(part);
  };

  const round1Calls: ContractCall[] = [];
  for (const acc of accounts) {
    round1Calls.push(ethBalanceCall(acc.address), usdcBalanceCall(acc.address), npmBalanceCall(acc.address));
  }
  const round1 = await multi(client, round1Calls);

  const basics = accounts.map((_, i) => {
    const ethWei = round1[i * 3];
    const usdcRaw = round1[i * 3 + 1];
    const npmCount = round1[i * 3 + 2];
    if (typeof ethWei !== "bigint" || typeof usdcRaw !== "bigint") miss(i, "balances");
    if (typeof npmCount !== "bigint") miss(i, "positions");
    return {
      ethWei: typeof ethWei === "bigint" ? ethWei : 0n,
      usdcRaw: typeof usdcRaw === "bigint" ? usdcRaw : 0n,
      // Accounts with no LP NFTs stop here: the later rounds never see them.
      npmCount: typeof npmCount === "bigint" ? Number(npmCount) : 0,
    };
  });

  const tokenIndexCalls: ContractCall[] = [];
  const tokenIndexOwner: number[] = [];
  basics.forEach((b, i) => {
    for (let idx = 0; idx < b.npmCount; idx++) {
      tokenIndexCalls.push(tokenOfOwnerByIndexCall(accounts[i].address, idx));
      tokenIndexOwner.push(i);
    }
  });
  const round2 = tokenIndexCalls.length ? await multi(client, tokenIndexCalls) : [];
  const tokenIds: { accountIndex: number; tokenId: bigint }[] = [];
  round2.forEach((r, i) => {
    if (typeof r === "bigint") tokenIds.push({ accountIndex: tokenIndexOwner[i], tokenId: r });
    else miss(tokenIndexOwner[i], "positions");
  });

  const round3 = tokenIds.length ? await multi(client, tokenIds.map((t) => positionsCall(t.tokenId))) : [];
  const positions: { accountIndex: number; raw: RawPosition }[] = [];
  tokenIds.forEach((t, i) => {
    const raw = round3[i] as RawPosition | undefined;
    if (raw) positions.push({ accountIndex: t.accountIndex, raw });
    else miss(t.accountIndex, "positions");
  });

  const uniquePools = new Map<string, { token0: string; token1: string; fee: number }>();
  for (const p of positions) {
    const [, , token0, token1, fee] = p.raw;
    uniquePools.set(poolKey(token0, token1, fee), { token0, token1, fee });
  }
  const poolEntries = [...uniquePools.values()];
  const poolAddresses = poolEntries.length
    ? await multi(client, poolEntries.map((p) => getPoolCall(p.token0, p.token1, p.fee)))
    : [];
  const poolAddressByKey = new Map<string, string>();
  poolEntries.forEach((p, i) => {
    const addr = poolAddresses[i];
    if (typeof addr === "string" && !isZeroAddress(addr)) poolAddressByKey.set(poolKey(p.token0, p.token1, p.fee), addr);
  });

  const uniquePoolAddresses = [...new Set(poolAddressByKey.values())];
  const slot0Results = uniquePoolAddresses.length
    ? await multi(client, uniquePoolAddresses.map((addr) => slot0Call(addr)))
    : [];
  const poolStateByAddress = new Map<string, PoolState>();
  uniquePoolAddresses.forEach((addr, i) => {
    const r = slot0Results[i] as readonly [bigint, number] | undefined;
    if (r) poolStateByAddress.set(addr.toLowerCase(), { sqrtPriceX96: r[0], tick: r[1] });
  });

  const priceUsd = (token: string) => priceUsdOf(prices, token);
  const perAccountLp = new Map<number, { usd: number; count: number; inRange: number }>();
  for (const p of positions) {
    const [, , token0, token1, fee, tickLower, tickUpper, liquidity, , , tokensOwed0, tokensOwed1] = p.raw;
    const entry = perAccountLp.get(p.accountIndex) ?? { usd: 0, count: 0, inRange: 0 };
    entry.count += 1;
    const poolAddress = poolAddressByKey.get(poolKey(token0, token1, fee));
    const pool = poolAddress ? poolStateByAddress.get(poolAddress.toLowerCase()) : undefined;
    if (pool) {
      const value = valuePosition(
        { token0, token1, tickLower, tickUpper, liquidity, tokensOwed0, tokensOwed1 },
        pool,
        priceUsd,
        decimalsOf,
      );
      if (value.usd !== null) entry.usd += value.usd;
      else miss(p.accountIndex, "prices");
      if (value.inRange) entry.inRange += 1;
    } else {
      miss(p.accountIndex, "pools");
    }
    perAccountLp.set(p.accountIndex, entry);
  }

  const rows = accounts.map((acc, i) => {
    const b = basics[i];
    const lp = perAccountLp.get(i) ?? { usd: 0, count: 0, inRange: 0 };
    const row: AccountView = {
      accountKey: shortKey(acc.account_key),
      address: acc.address,
      basescanUrl: basescanAddress(acc.address),
      ethBalance: weiToEth(b.ethWei),
      usdcIdle: unitsToNumber(b.usdcRaw, 6),
      lpUsd: lp.usd,
      positions: lp.count,
      inRange: lp.inRange,
    };
    if (unread.has(i)) row.unread = true;
    return row;
  });
  return { rows, unreadAccounts: unread.size, parts };
}

function emptyAccountsView(error: string): AccountsView {
  return { totalUsers: 0, totalAccounts: 0, last7d: 0, rows: [], tvlUsd: 0, idleUsdcUsd: 0, lpUsd: 0, gasReservesEth: 0, error };
}

async function buildAccountsView(
  env: InfraEnv,
  client: BaseClient | null,
  prices: Prices | null,
): Promise<AccountsView | null> {
  if (!env.MAMORU_DB) return null;
  let counts: Awaited<ReturnType<typeof fetchInfraCounts>>;
  try {
    counts = await fetchInfraCounts(env.MAMORU_DB);
  } catch {
    return emptyAccountsView("Could not read the accounts database.");
  }
  if (!client) {
    return { ...counts, rows: [], tvlUsd: 0, idleUsdcUsd: 0, lpUsd: 0, gasReservesEth: 0, error: "Base RPC is unreachable; balances are not shown." };
  }
  let accounts: AccountRow[];
  try {
    accounts = await fetchChainAccounts(env.MAMORU_DB, CHAIN_ID);
  } catch {
    return { ...counts, rows: [], tvlUsd: 0, idleUsdcUsd: 0, lpUsd: 0, gasReservesEth: 0, error: "Could not read the account list." };
  }
  try {
    const { rows, unreadAccounts, parts } = await valueAccounts(client, accounts, prices);
    return {
      ...counts,
      rows,
      ...(unreadAccounts ? { unreadAccounts, unreadParts: [...parts] } : {}),
      tvlUsd: rows.reduce((sum, r) => sum + r.usdcIdle + r.lpUsd, 0),
      idleUsdcUsd: rows.reduce((sum, r) => sum + r.usdcIdle, 0),
      lpUsd: rows.reduce((sum, r) => sum + r.lpUsd, 0),
      gasReservesEth: rows.reduce((sum, r) => sum + r.ethBalance, 0),
    };
  } catch {
    return { ...counts, rows: [], tvlUsd: 0, idleUsdcUsd: 0, lpUsd: 0, gasReservesEth: 0, error: "Could not read on-chain balances for accounts." };
  }
}

/**
 * `client` defaults to a real Base client; tests inject a fake one so none of
 * this ever makes a real network call.
 */
export async function computeInfraSnapshot(
  env: InfraEnv,
  client: BaseClient = buildClient(env.BASE_RPC_URL),
): Promise<InfraSnapshot> {
  const asOf = new Date().toISOString();

  let gasPriceWei: bigint;
  let relayerBalanceWei: bigint;
  let prices: Prices;
  try {
    const pools = await resolveReferencePools(client);
    [gasPriceWei, relayerBalanceWei, prices] = await Promise.all([
      client.getGasPrice(),
      client.getBalance({ address: RELAYER_ADDRESS as Address }),
      resolvePrices(client, pools),
    ]);
  } catch {
    return {
      asOf,
      rpcError: "Base RPC is unreachable right now.",
      ethUsd: null,
      btcUsd: null,
      relayer: null,
      cost: null,
      accounts: await buildAccountsView(env, null, null),
    };
  }

  const relayerEth = weiToEth(relayerBalanceWei);
  const relayer: RelayerView = {
    address: RELAYER_ADDRESS,
    basescanUrl: basescanAddress(RELAYER_ADDRESS),
    ethBalance: relayerEth,
    usd: ethToUsd(relayerEth, prices.ethUsd),
    status: relayerStatus(relayerBalanceWei),
  };

  const breakdown = costPerAccount(gasPriceWei);
  const cost: CostView = {
    gasPriceGwei: Number(gasPriceWei) / 1e9,
    deployEth: weiToEth(breakdown.deployWei),
    deployUsd: ethToUsd(weiToEth(breakdown.deployWei), prices.ethUsd),
    activationEth: weiToEth(breakdown.activationWei),
    activationUsd: ethToUsd(weiToEth(breakdown.activationWei), prices.ethUsd),
    reserveEth: weiToEth(breakdown.reserveWei),
    reserveUsd: ethToUsd(weiToEth(breakdown.reserveWei), prices.ethUsd),
    totalEth: weiToEth(breakdown.totalWei),
    totalUsd: ethToUsd(weiToEth(breakdown.totalWei), prices.ethUsd),
    totalWei: breakdown.totalWei.toString(),
    accountsFunded: accountsFunded(relayerBalanceWei, breakdown.totalWei),
  };

  const accounts = await buildAccountsView(env, client, prices);

  // A missing ETH price leaves every USD figure blank; unread accounts leave totals short.
  const parts = new Set<UnreadPart>(accounts?.unreadParts ?? []);
  if (prices.ethUsd === null) parts.add("prices");
  const partial: PartialRead | undefined = parts.size
    ? { unreadAccounts: accounts?.unreadAccounts ?? 0, parts: [...parts] }
    : undefined;

  return { asOf, ...(partial ? { partial } : {}), ethUsd: prices.ethUsd, btcUsd: prices.btcUsd, relayer, cost, accounts };
}
