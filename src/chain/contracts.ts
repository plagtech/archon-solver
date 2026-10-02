import { Contract, type ContractRunner } from 'ethers';
import type { Config } from '../config.js';
import IntentEngineAbi from './abis/IntentEngine.json' with { type: 'json' };
import ArchonRouterAbi from './abis/ArchonRouter.json' with { type: 'json' };
import AgentVaultAbi from './abis/AgentVault.json' with { type: 'json' };
import StablePoolAbi from './abis/StablePool.json' with { type: 'json' };
import VolatilePoolAbi from './abis/VolatilePool.json' with { type: 'json' };

export { IntentEngineAbi, ArchonRouterAbi, AgentVaultAbi, StablePoolAbi, VolatilePoolAbi };

export interface Contracts {
  engine: Contract;
  router: Contract;
  /** Pool contracts keyed by pool address */
  pools: Map<string, Contract>;
  vault(address: string): Contract;
}

export function createContracts(config: Config, runner: ContractRunner): Contracts {
  const pools = new Map<string, Contract>();
  for (const pair of config.pairs) {
    const abi = pair.type === 'stable' ? StablePoolAbi : VolatilePoolAbi;
    pools.set(pair.pool, new Contract(pair.pool, abi, runner));
  }

  return {
    engine: new Contract(config.addresses.engine, IntentEngineAbi, runner),
    router: new Contract(config.addresses.router, ArchonRouterAbi, runner),
    pools,
    vault: (address: string) => new Contract(address, AgentVaultAbi, runner),
  };
}
