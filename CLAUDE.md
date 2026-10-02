# Archon Solver — Off-Chain Intent Matching Service

## What This Is

The Archon Solver is the off-chain service that makes the Archon DEX usable by agents.
It receives signed swap intents via API, matches opposing intents for better-than-pool
execution, and submits batches to the on-chain IntentEngine for settlement.

This is to Archon what the Spraay gateway is to the Spraay batch contracts — the API
layer that agents actually talk to.

**Repo:** plagtech/archon-solver
**Language:** TypeScript (Node.js)
**Deployment target:** Railway
**Domain:** solver.archon.exchange (configure after deployment)

## Deployed Contracts (Base mainnet, chain 8453)

Read the full list from the contracts repo at `deployments/8453.json`. Key addresses:

- **ArchonRouter:** 0x45B3042c8a4C2D540a15E89C13B65392d2e14289
- **VaultFactory:** 0x58C92a2e7e3b5c3897Ab03466e7f5c1030A40F29
- **IntentEngine:** 0xf8614FED7664B2505EfD04581f1417D8317648D8
- **SpraayAdapter:** 0xcF0bE3C00c2D4931315ED524161Dd124626044c2
- **StablePool USDC/USDT:** 0x9c77673FBC4aa696a81FFeEead58973E18A1C242
- **StablePool USDC/DAI:** 0x98B17F4615a5c32C7e3B0b91ba46445f3b582B40
- **VolatilePool USDC/WETH:** 0xEed7535E76Ac2ddF8bb649007d28A30b8f3B2CD8

Token addresses on Base:
- USDC: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 (6 decimals)
- USDT: 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2 (6 decimals)
- DAI: 0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb (18 decimals)
- WETH: 0x4200000000000000000000000000000000000006 (18 decimals)

## Architecture

```
Agent (AI)
  │
  ├── POST /intent (signed swap intent)
  │
  ▼
Archon Solver
  ├── Validate intent format + signature format
  ├── Add to memory pool, grouped by token pair
  ├── Every 2-5 seconds: run matching cycle
  │     ├── Find opposing intents (coincidence of wants)
  │     ├── Query pool spot price for the pair
  │     ├── Calculate matched amounts at spot price
  │     ├── Remaining unmatched → direct pool swap via router
  │     └── Encode batch for IntentEngine
  ├── Submit settlement tx with solver key
  ├── Monitor confirmation
  └── Push events to connected agents via WebSocket
```

## Components to Build

### 1. Intent API (HTTP + WebSocket)

**POST /intent** — Submit a signed swap intent

Request body:
```json
{
  "vault": "0x...",
  "sessionKey": "0x...",
  "tokenIn": "0x...",
  "tokenOut": "0x...",
  "amountIn": "1000000",
  "minAmountOut": "990000",
  "deadline": 1727812800,
  "nonce": 0,
  "signature": "0x..."
}
```

Response:
```json
{
  "intentId": "0x...",
  "status": "pending",
  "estimatedSettlement": 1727812805
}
```

Validation (solver-side, before accepting):
- All fields present and correctly typed
- deadline > current timestamp
- signature is 65 bytes (valid ECDSA format)
- tokenIn and tokenOut are in the supported pairs list
- vault address has code on-chain (is a real contract)
- Do NOT verify the signature on-chain here — the IntentEngine does that. The solver
  just checks format to avoid wasting gas on obviously bad intents.

**GET /quote** — Get a price quote for a pair

Request: `?tokenIn=0x...&tokenOut=0x...&amountIn=1000000`

Response:
```json
{
  "expectedOut": "999400",
  "priceImpactBps": 2,
  "poolFee": "400",
  "spotPrice": "1.0000"
}
```

This calls the pool's `simulateSwap()` view function.

**GET /pairs** — List supported trading pairs

Returns all pairs with their pool addresses, pool type (stable/volatile), fee, and
current liquidity.

**GET /status/:intentId** — Check intent status

Returns: pending, matched, settling, settled, refunded, or expired.

**WebSocket /ws** — Real-time event stream

Events pushed to connected clients:
- `intent.accepted` — intent entered the pool
- `intent.matched` — intent matched with an opposing intent
- `intent.settled` — settlement confirmed on-chain (includes tx hash)
- `intent.refunded` — intent was refunded (fell below minimum)
- `intent.expired` — deadline passed without settlement
- `batch.settled` — a batch settled (summary: pair, count, total volume)
- `pool.price` — price update for a pair (on significant moves)

### 2. Intent Memory Pool

In-memory store (not persistent — intents have short deadlines, and the solver restarts
clean). Structure:

```typescript
interface PendingIntent {
  id: string;                // keccak256 of the signed intent
  vault: string;
  sessionKey: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  minAmountOut: bigint;
  deadline: number;
  nonce: number;
  signature: string;
  receivedAt: number;
  status: 'pending' | 'matching' | 'settling' | 'settled' | 'refunded' | 'expired';
}

// Grouped by pair for matching
type PairKey = `${string}-${string}`;  // sorted token addresses
Map<PairKey, PendingIntent[]>
```

Expiry: intents whose deadline has passed are removed every cycle.

### 3. Matching Engine

Runs every MATCH_INTERVAL (default 3 seconds). For each pair with pending intents:

1. **Separate sides.** Group intents by direction: those selling tokenA for tokenB
   vs those selling tokenB for tokenA.

2. **Get spot price.** Call the pool's `spotPrice()` view function. This is the
   price the IntentEngine will use for matching (it reads the same function).

3. **Match opposing intents.** Walk both sides, matching amounts at spot price.
   - Agent A sells 1000 USDC for DAI, Agent B sells 500 DAI for USDC
   - At spot price 1.0: A gets 500 DAI from the match, B gets 500 USDC from the match
   - A's remaining 500 USDC goes through the pool
   - Matched portions pay NO pool fee and have ZERO price impact

4. **Check minimums.** For each intent, verify the total output (matched + pool)
   meets the agent's minAmountOut. If not, exclude that intent and re-match.

5. **Encode batch.** Build the IntentEngine.settleBatch calldata:
   - Array of signed intents in the format the contract expects
   - The contract re-verifies every signature and runs every safety check

6. **Submit or fall through.**
   - If there are matched intents: submit to IntentEngine.settleBatch
   - If only one side has intents (no match possible): submit each as a direct
     swap through the router (call AgentVault.submitSwapIntent for each)
   - If nothing is pending: skip

### 4. Settlement Submitter

Submits transactions to Base using the solver's private key.

- Uses ethers.js v6 (or viem — pick one, don't mix)
- Gas estimation with 1.5x buffer (same pattern as the Spraay gateway)
- Retry logic: if a tx fails, check the revert reason. If it's a nonce issue,
  resync nonce and retry. If it's a contract revert (bad signature, frozen vault),
  mark those intents as failed and re-submit without them.
- Private submission: use Flashbots Protect RPC for Base to prevent sandwich attacks
  on batch settlement transactions. Flashbots Protect for Base:
  https://rpc.flashbots.net/fast (check current URL before using)
- The solver key must be registered on the IntentEngine via engine.setSolver(address).
  This is an admin call — the deployer must do it once after the solver is deployed.

### 5. Event Listener

Listens to on-chain events from the deployed contracts:

- IntentEngine: BatchSettled, IntentRefunded
- AgentVault (all vaults): SwapExecuted, SwapIntentBlocked, CircuitBreakerTriggered,
  Frozen, Unfrozen
- Pools: Swap events for price tracking

Uses ethers.js WebSocket provider or polling (Base supports both).
Pushes relevant events to connected WebSocket clients.

### 6. Health & Monitoring

**GET /health** — Returns:
```json
{
  "status": "ok",
  "chain": 8453,
  "solverAddress": "0x...",
  "pendingIntents": 5,
  "lastSettlement": "2026-10-01T14:30:00Z",
  "poolPrices": {
    "USDC/DAI": "1.0000",
    "USDC/USDT": "1.0001",
    "USDC/WETH": "2697.50"
  },
  "uptime": 3600
}
```

**GET /stats** — Returns settlement statistics:
- Total batches settled
- Total volume by pair
- Average match rate (% of intents matched vs pool-routed)
- Average settlement time

## Environment Variables

```
# Required
SOLVER_PRIVATE_KEY=0x...          # The solver's signing key (must be setSolver'd on IntentEngine)
BASE_RPC_URL=https://mainnet.base.org
BASE_WS_URL=wss://...            # WebSocket RPC for event listening (if available)

# Optional
PORT=3000                         # HTTP server port
MATCH_INTERVAL=3000               # Milliseconds between matching cycles
FLASHBOTS_RPC=https://rpc.flashbots.net/fast  # Private tx submission
DEPLOYMENT_FILE=./deployments/8453.json       # Contract addresses

# Contract addresses (override deployment file)
ROUTER_ADDRESS=0x45B3042c8a4C2D540a15E89C13B65392d2e14289
ENGINE_ADDRESS=0xf8614FED7664B2505EfD04581f1417D8317648D8
VAULT_FACTORY_ADDRESS=0x58C92a2e7e3b5c3897Ab03466e7f5c1030A40F29
```

## Project Structure

```
archon-solver/
├── src/
│   ├── index.ts              # Entry point — starts HTTP server, WS server, matching loop
│   ├── api/
│   │   ├── routes.ts         # Express/Fastify route handlers
│   │   └── websocket.ts      # WebSocket event broadcasting
│   ├── engine/
│   │   ├── mempool.ts        # Intent memory pool
│   │   ├── matcher.ts        # Matching engine (coincidence of wants)
│   │   └── submitter.ts      # Transaction submission + retry logic
│   ├── chain/
│   │   ├── provider.ts       # RPC provider setup
│   │   ├── contracts.ts      # Contract instances (ethers.js)
│   │   ├── events.ts         # On-chain event listener
│   │   └── abis/             # Contract ABIs (extracted from Foundry out/)
│   │       ├── IntentEngine.json
│   │       ├── ArchonRouter.json
│   │       ├── AgentVault.json
│   │       ├── StablePool.json
│   │       └── VolatilePool.json
│   ├── types/
│   │   └── intent.ts         # Shared types
│   └── config.ts             # Environment + contract address loading
├── test/
│   ├── mempool.test.ts
│   ├── matcher.test.ts
│   └── integration.test.ts   # Fork test: submit intent → match → settle on-chain
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
├── Dockerfile                # For Railway deployment
└── CLAUDE.md                 # This file
```

## Contract ABIs

Extract ABIs from the contracts repo's Foundry build output. The files needed are:

- `out/IntentEngine.sol/IntentEngine.json` → `.abi` field
- `out/ArchonRouter.sol/ArchonRouter.json` → `.abi` field
- `out/AgentVault.sol/AgentVault.json` → `.abi` field
- `out/StablePool.sol/StablePool.json` → `.abi` field
- `out/VolatilePool.sol/VolatilePool.json` → `.abi` field

These are in the `plagtech/archon` repo under `out/` after running `forge build`.
Copy just the ABI arrays, not the full build artifacts.

## Key Contract Interfaces the Solver Calls

### IntentEngine.settleBatch

This is the main entry point. The solver submits an array of signed intents for one
token pair. The contract handles pull, clear (match + pool), and deliver.

Refer to `src/settlement/IntentEngine.sol` in the contracts repo for:
- The exact struct format for batch intents
- How signatures are verified (different format from single swaps)
- The clearing algorithm (opposing intents matched at spot price, remainder through pool)

### AgentVault.submitSwapIntent

For unmatched intents that should go through the pool directly. Any address can call
this (the session key signature is what authorizes it, not msg.sender).

### Pool.spotPrice / Pool.simulateSwap

Read-only calls for quoting and price discovery. The solver needs these to:
- Respond to GET /quote requests
- Determine the matching price for the engine
- Verify agents' minimums will be met before submitting

## Build Order

1. **Project scaffold** — package.json, tsconfig, .env.example, .gitignore, Dockerfile
2. **Config + provider** — load env vars, set up ethers provider, instantiate contracts
3. **ABI extraction** — copy ABIs from the contracts repo
4. **Intent API** — POST /intent, GET /quote, GET /pairs, GET /status
5. **Memory pool** — store, group, expire intents
6. **Matching engine** — the core algorithm: separate sides, get price, match, check mins
7. **Settlement submitter** — encode calldata, submit tx, handle failures
8. **Event listener** — watch on-chain events, update intent statuses
9. **WebSocket** — broadcast events to connected agents
10. **Health endpoint** — /health, /stats
11. **Integration test** — fork test that submits two opposing intents and verifies settlement

## Important Constraints

- The solver's address must be registered on IntentEngine. After deploying the solver,
  the Archon admin calls `engine.setSolver(solverAddress)`. Without this, settleBatch reverts.
- The solver NEVER holds user funds. It only submits transactions — the IntentEngine
  pulls from vaults directly.
- The solver key should be a hot wallet with minimal ETH for gas. If compromised, the
  attacker can only submit batches (which still require valid agent signatures) — they
  cannot steal vault funds.
- Intent signatures are chain-bound (include chain ID) and vault-bound (include vault
  address). An intent signed for one chain/vault cannot be replayed on another.
- Batch intent signatures use a DIFFERENT format from single swap signatures. The
  contracts enforce this separation. Check IntentEngine for the batch signing format.

## Testing

Unit tests with vitest or jest. Integration test against a Base fork (same pattern as
the contracts repo's fork tests — skip without BASE_RPC_URL).

For the integration test: deploy contracts on a fork, create a vault, deposit tokens,
register a session key, submit two opposing intents through the solver API, and verify
settlement on the fork.

## Deployment

Railway with a Dockerfile. Same deployment pattern as the Spraay gateway:
- Push to main triggers deploy
- Environment variables set in Railway dashboard
- Health check on GET /health

After Railway deployment:
1. Note the solver's public address
2. Archon admin calls engine.setSolver(solverAddress) on Base mainnet
3. Point solver.archon.exchange DNS to the Railway URL
