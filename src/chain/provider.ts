import { JsonRpcProvider, Network, Wallet } from 'ethers';
import type { Config } from '../config.js';

export function createProvider(config: Config): JsonRpcProvider {
  // staticNetwork skips the eth_chainId round-trip on every request
  const network = Network.from(config.chainId);
  return new JsonRpcProvider(config.rpcUrl, network, {
    staticNetwork: network,
    // Public Base RPC rejects JSON-RPC batches larger than 10 calls
    batchMaxCount: config.rpcBatchMax,
  });
}

export function createSolverWallet(config: Config, provider: JsonRpcProvider): Wallet {
  return new Wallet(config.solverPrivateKey, provider);
}
