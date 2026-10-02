import { loadConfig } from './config.js';
import { createProvider, createSolverWallet } from './chain/provider.js';
import { createContracts } from './chain/contracts.js';
import { Market } from './chain/market.js';
import { Mempool } from './engine/mempool.js';
import { MatchingLoop } from './engine/matcher.js';
import { DryRunSubmitter } from './engine/submitter.js';
import { createApp } from './api/routes.js';

async function main() {
  const config = loadConfig();
  const provider = createProvider(config);
  const wallet = createSolverWallet(config, provider);
  const contracts = createContracts(config, provider);
  const market = new Market(config, contracts);
  const mempool = new Mempool();

  const isSolver: boolean = await contracts.engine.isSolver(wallet.address);
  if (!isSolver) {
    console.warn(
      `[solver] ${wallet.address} is not authorized on IntentEngine ${config.addresses.engine}; ` +
        'settleBatch will revert until the admin calls setSolver(address, true)',
    );
  }

  const loop = new MatchingLoop({
    mempool,
    pairs: config.pairs,
    quoter: market.clearingQuoter,
    submitter: new DryRunSubmitter(mempool, contracts.engine.interface),
    intervalMs: config.matchIntervalMs,
    deadlineBufferSec: config.deadlineBufferSec,
  });
  loop.start();

  const app = createApp({ config, market, mempool, solverAddress: wallet.address });
  const server = app.listen(config.port, () => {
    console.log(`[solver] ${wallet.address} listening on :${config.port} (chain ${config.chainId})`);
  });

  const shutdown = () => {
    loop.stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[solver] fatal', err);
  process.exit(1);
});
