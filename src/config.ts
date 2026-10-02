import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getAddress, isAddress } from 'ethers';

export interface TokenInfo {
  symbol: string;
  address: string;
  decimals: number;
}

export interface PairConfig {
  /** e.g. "USDC/DAI" */
  name: string;
  pool: string;
  type: 'stable' | 'volatile';
  /** Token addresses in canonical (sorted) order; tokenA is the lower address */
  tokenA: string;
  tokenB: string;
}

export interface Config {
  chainId: number;
  port: number;
  matchIntervalMs: number;
  deadlineBufferSec: number;
  rpcBatchMax: number;
  solverPrivateKey: string;
  rpcUrl: string;
  wsUrl?: string;
  flashbotsRpc?: string;
  addresses: {
    router: string;
    engine: string;
    vaultFactory: string;
  };
  tokens: TokenInfo[];
  pairs: PairConfig[];
}

const TOKENS: TokenInfo[] = [
  { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
  { symbol: 'USDT', address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', decimals: 6 },
  { symbol: 'DAI', address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18 },
  { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
];

/** Pools by their key in the deployment file */
const PAIRS: { deploymentKey: string; symbols: [string, string]; type: PairConfig['type'] }[] = [
  { deploymentKey: 'PoolUsdcUsdt', symbols: ['USDC', 'USDT'], type: 'stable' },
  { deploymentKey: 'PoolUsdcDai', symbols: ['USDC', 'DAI'], type: 'stable' },
  { deploymentKey: 'PoolUsdcWeth', symbols: ['USDC', 'WETH'], type: 'volatile' },
];

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function address(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isAddress(value)) throw new Error(`Invalid address for ${label}`);
  return getAddress(value);
}

/** Sort two addresses so every pair has a single canonical key */
export function sortTokens(a: string, b: string): [string, string] {
  return a.toLowerCase() < b.toLowerCase() ? [getAddress(a), getAddress(b)] : [getAddress(b), getAddress(a)];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const deploymentPath = resolve(env.DEPLOYMENT_FILE ?? './deployments/8453.json');
  const deployment = JSON.parse(readFileSync(deploymentPath, 'utf8')) as Record<string, unknown>;

  const chainId = Number(deployment.chainId ?? 8453);
  const bySymbol = new Map(TOKENS.map((t) => [t.symbol, t]));

  const pairs = PAIRS.map(({ deploymentKey, symbols, type }) => {
    const [tokenA, tokenB] = sortTokens(bySymbol.get(symbols[0])!.address, bySymbol.get(symbols[1])!.address);
    return {
      name: symbols.join('/'),
      pool: address(deployment[deploymentKey], deploymentKey),
      type,
      tokenA,
      tokenB,
    };
  });

  return {
    chainId,
    port: intEnv('PORT', 3000),
    matchIntervalMs: intEnv('MATCH_INTERVAL', 3000),
    deadlineBufferSec: intEnv('DEADLINE_BUFFER_SEC', 6),
    rpcBatchMax: intEnv('RPC_BATCH_MAX', 10),
    solverPrivateKey: required('SOLVER_PRIVATE_KEY'),
    rpcUrl: required('BASE_RPC_URL'),
    wsUrl: env.BASE_WS_URL || undefined,
    flashbotsRpc: env.FLASHBOTS_RPC || undefined,
    addresses: {
      router: address(env.ROUTER_ADDRESS || deployment.ArchonRouter, 'ArchonRouter'),
      engine: address(env.ENGINE_ADDRESS || deployment.IntentEngine, 'IntentEngine'),
      vaultFactory: address(env.VAULT_FACTORY_ADDRESS || deployment.VaultFactory, 'VaultFactory'),
    },
    tokens: TOKENS.map((t) => ({ ...t, address: getAddress(t.address) })),
    pairs,
  };
}
