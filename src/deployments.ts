/**
 * What Mamoru has deployed or uses on each chain, for the Funding section (otto/mamoru-astro#32). A copy of the
 * entries that matter to an operator from ottodevs/mamoru `packages/registry/{base,monad}.json` (addresses only);
 * the registry stays the source of truth and pins every code hash. Ethereum has no registry: nothing of Mamoru runs
 * there, the relayer only deploys an owner's Safe to bring USDC sent there back to Base (otto/mamoru#180).
 */

export interface Deployed {
  name: string;
  /** What it does for Mamoru, one line. */
  role: string;
  address: string;
}

export interface ChainDeployment {
  /** FundingChain.chainId of the same chain. */
  chainId: number;
  name: string;
  /** What Mamoru does on this chain, one sentence. */
  role: string;
  /** Mamoru's own contracts and the stack every account is built from. */
  contracts: readonly Deployed[];
}

const SAFE_STACK: readonly Deployed[] = [
  { name: "Safe 1.4.1 + factory", role: "every account is a Safe", address: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67" },
  { name: "Safe7579", role: "ERC-7579 modules on the Safe", address: "0x7579EE8307284F293B1927136486880611F20002" },
  { name: "SmartSession", role: "the engine's session keys", address: "0x00000000002B0eCfbD0496EE71e01257dA0E37DE" },
  { name: "SafeWebAuthnSharedSigner", role: "the owner's passkey", address: "0x94a4F6affBd8975951142c3999aEAB7ecee555c2" },
];

export const DEPLOYMENTS: readonly ChainDeployment[] = [
  {
    chainId: 8453,
    name: "Base",
    role: "Where accounts live and earn: Safes, the policy that bounds the engine, and the curated Uniswap pools.",
    contracts: [
      { name: "MamoruActionPolicy v2", role: "bounds every engine action; the guardian can pause it per account", address: "0x9ef35e544C93A6722a13473AB9EF115f719bbE6B" },
      ...SAFE_STACK,
      { name: "Pool cbBTC/USDC 0.05%", role: "Bitcoin bucket", address: "0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef" },
      { name: "Pool WETH/USDC 0.3%", role: "Ether bucket", address: "0x6c561B446416E1A00E8E93E221854d6eA4171372" },
      { name: "Pool USDC/USDT 0.01%", role: "stables bucket", address: "0xD56da2B74bA826f19015E6B7Dd9Dae1903E85DA1" },
    ],
  },
  {
    chainId: 143,
    name: "Monad",
    role: "Second chain: the same Safe and session stack, its own relayer and operator; no Mamoru policy contract yet.",
    contracts: [
      ...SAFE_STACK,
      { name: "Pool WMON/USDC 0.3%", role: "MON bucket", address: "0x659bD0BC4167BA25c62E05656F78043E7eD4a9da" },
    ],
  },
  {
    chainId: 1,
    name: "Ethereum",
    role: "Recovery only: the relayer deploys an owner's Safe here to move USDC sent to Ethereum back to Base.",
    contracts: [{ name: "Safe 1.4.1 factory", role: "the owner's Safe, deployed on demand", address: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67" }],
  },
];
