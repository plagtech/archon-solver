import { JsonRpcProvider, Network, formatEther } from 'ethers';
import { loadConfig } from './config.js';
import { createProvider, createSolverWallet } from './chain/provider.js';
import { createContracts } from './chain/contracts.js';
import { Market } from './chain/market.js';
import { NonceManager } from './chain/nonce.js';
import { EthersSolverChain } from './chain/solver-chain.js';
import { ChainEventListener } from './chain/events.js';
import { Mempool } from './engine/mempool.js';
import { MatchingLoop } from './engine/matcher.js';
import { SettlementSubmitter } from './engine/submitter.js';
import { EventBus, publishIntentEvents } from './events.js';
import { createApp } from './api/routes.js';
import { attachWebSocket } from './api/websocket.js';
import { StatsCollector } from './stats.js';

const SHUTDOWN_GRACE_MS = 15_000;

async function main() {
  const config = loadConfig();
  const provider = createProvider(config);
  const network = Network.from(config.chainId);
  const sendProvider = config.privateRpcUrl
    ? new JsonRpcProvider(config.privateRpcUrl, network, { staticNetwork: network, batchMaxCount: 1 })
    : provider;
  const wallet = createSolverWallet(config, provider);
  const contracts = createContracts(config, provider);
  const market = new Market(config, contracts);
  const mempool = new Mempool();
  const stats = new StatsCollector(config, wallet.address, mempool);
  const bus = new EventBus();
  publishIntentEvents(mempool, bus);

  const [isSolver, balance] = await Promise.all([
    contracts.engine.isSolver(wallet.address) as Promise<boolean>,
    provider.getBalance(wallet.address),
  ]);
  if (!isSolver) {
    console.warn(
      `[solver] ${wallet.address} is not authorized on IntentEngine ${config.addresses.engine}; ` +
        'settleBatch will revert until the admin calls setSolver(address, true)',
    );
  }
  if (balance === 0n) console.warn(`[solver] ${wallet.address} has no ETH for gas`);

  const chain = new EthersSolverChain({
    provider,
    sendProvider,
    wallet,
    chainId: config.chainId,
    engineAddress: config.addresses.engine,
    engineInterface: contracts.engine.interface,
    vault: contracts.vault,
  });
  const submitter = new SettlementSubmitter(
    chain,
    new NonceManager(chain, wallet.address),
    mempool,
    contracts.engine.interface,
    config.addresses.engine,
    { stats },
  );

  const loop = new MatchingLoop({
    mempool,
    pairs: config.pairs,
    quoter: market.clearingQuoter,
    submitter,
    intervalMs: config.matchIntervalMs,
    deadlineBufferSec: config.deadlineBufferSec,
  });

  const listener = new ChainEventListener(provider, config, market, mempool, bus, {
    pollMs: config.eventPollMs,
    priceMoveBps: config.priceMoveBps,
  });
  await listener.start();
  loop.start();

  const app = createApp({
    config,
    market,
    mempool,
    solverAddress: wallet.address,
    stats,
    poolPrices: () => listener.poolPrices(),
    lastSettlement: () => submitter.lastSettlement,
  });
  const server = app.listen(config.port, () => {
    console.log(
      `[solver] ${wallet.address} listening on :${config.port} (chain ${config.chainId}, ` +
        `${formatEther(balance)} ETH, tx via ${config.privateRpcUrl ? 'private RPC' : 'BASE_RPC_URL'})`,
    );
  });
  const ws = attachWebSocket(server, bus);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[solver] shutting down; waiting for in-flight settlements');
    loop.stop();
    ws.close();
    server.close();
    // Keep the listener running so receipts and events for in-flight batches still land
    const grace = new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS));
    await Promise.race([submitter.drain(), grace]);
    listener.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  console.error('[solver] fatal', err);
  process.exit(1);
});
