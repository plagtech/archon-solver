import { Transaction, type Interface, type JsonRpcProvider, type Wallet } from 'ethers';

export interface TxFees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface SettleTx extends TxFees {
  data: string;
  nonce: number;
  gasLimit: bigint;
}

export interface RawLog {
  address: string;
  topics: readonly string[];
  data: string;
}

export interface TxReceiptInfo {
  status: number;
  blockNumber: number;
  logs: RawLog[];
  gasUsed: bigint;
  /** Price actually paid per gas unit (wei) */
  effectiveGasPrice: bigint;
}

/** Vault state that decides whether a batch leg will be pulled */
export interface VaultLegState {
  frozen: boolean;
  keyActive: boolean;
  canBatchSwap: boolean;
  keyExpiry: bigint;
  keyNonce: bigint;
  balance: bigint;
  tokenInAllowed: boolean;
  tokenOutAllowed: boolean;
}

/** Everything the settlement submitter needs from the chain */
export interface SolverChain {
  readonly solverAddress: string;
  /** eth_call settleBatch from the solver; throws on revert */
  simulateSettle(data: string): Promise<{ filled: bigint }>;
  estimateGas(data: string): Promise<bigint>;
  feeData(): Promise<TxFees>;
  sign(tx: SettleTx): Promise<{ raw: string; hash: string }>;
  broadcast(raw: string): Promise<void>;
  /** Whether a node already knows this tx (it may have been broadcast despite an error) */
  knowsTransaction(hash: string): Promise<boolean>;
  receipt(hash: string): Promise<TxReceiptInfo | null>;
  /** Re-run a mined, reverted settle call to recover its revert reason; returns the error */
  replay(data: string, blockNumber: number): Promise<unknown>;
  getTransactionCount(address: string, blockTag: 'pending' | 'latest'): Promise<number>;
  vaultLegState(vault: string, sessionKey: string, tokenIn: string, tokenOut: string): Promise<VaultLegState>;
}

interface EthersSolverChainDeps {
  provider: JsonRpcProvider;
  /** Where signed txs are sent (a private RPC if configured, else `provider`) */
  sendProvider: JsonRpcProvider;
  wallet: Wallet;
  chainId: number;
  engineAddress: string;
  engineInterface: Interface;
  vault: (address: string) => import('ethers').Contract;
}

export class EthersSolverChain implements SolverChain {
  readonly solverAddress: string;

  constructor(private readonly deps: EthersSolverChainDeps) {
    this.solverAddress = deps.wallet.address;
  }

  async simulateSettle(data: string): Promise<{ filled: bigint }> {
    const raw = await this.deps.provider.call({ to: this.deps.engineAddress, from: this.solverAddress, data });
    const [, filled] = this.deps.engineInterface.decodeFunctionResult('settleBatch', raw);
    return { filled };
  }

  estimateGas(data: string): Promise<bigint> {
    return this.deps.provider.estimateGas({ to: this.deps.engineAddress, from: this.solverAddress, data });
  }

  async feeData(): Promise<TxFees> {
    const fees = await this.deps.provider.getFeeData();
    if (fees.maxFeePerGas !== null && fees.maxPriorityFeePerGas !== null) {
      return { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
    }
    const gasPrice = fees.gasPrice ?? 0n;
    return { maxFeePerGas: gasPrice, maxPriorityFeePerGas: gasPrice };
  }

  async sign(tx: SettleTx): Promise<{ raw: string; hash: string }> {
    const raw = await this.deps.wallet.signTransaction({
      type: 2,
      chainId: this.deps.chainId,
      to: this.deps.engineAddress,
      data: tx.data,
      nonce: tx.nonce,
      gasLimit: tx.gasLimit,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
    });
    return { raw, hash: Transaction.from(raw).hash! };
  }

  async broadcast(raw: string): Promise<void> {
    await this.deps.sendProvider.broadcastTransaction(raw);
  }

  async knowsTransaction(hash: string): Promise<boolean> {
    for (const provider of new Set([this.deps.sendProvider, this.deps.provider])) {
      try {
        if (await provider.getTransaction(hash)) return true;
      } catch {
        // private RPCs may not serve reads
      }
    }
    return false;
  }

  async receipt(hash: string): Promise<TxReceiptInfo | null> {
    const r = await this.deps.provider.getTransactionReceipt(hash);
    if (!r) return null;
    return {
      status: r.status ?? 0,
      blockNumber: r.blockNumber,
      gasUsed: r.gasUsed,
      effectiveGasPrice: r.gasPrice,
      logs: r.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data })),
    };
  }

  async replay(data: string, blockNumber: number): Promise<unknown> {
    try {
      // State before the block; close enough to reproduce a precondition failure
      await this.deps.provider.call({
        to: this.deps.engineAddress,
        from: this.solverAddress,
        data,
        blockTag: blockNumber - 1,
      });
      return null;
    } catch (err) {
      return err;
    }
  }

  getTransactionCount(address: string, blockTag: 'pending' | 'latest'): Promise<number> {
    return this.deps.provider.getTransactionCount(address, blockTag);
  }

  async vaultLegState(vault: string, sessionKey: string, tokenIn: string, tokenOut: string): Promise<VaultLegState> {
    const v = this.deps.vault(vault);
    const [frozen, key, balance, tokenInAllowed, tokenOutAllowed] = await Promise.all([
      v.frozen() as Promise<boolean>,
      v.sessionKeys(sessionKey),
      v.getBalance(tokenIn) as Promise<bigint>,
      v.tokenAllowlist(tokenIn) as Promise<boolean>,
      v.tokenAllowlist(tokenOut) as Promise<boolean>,
    ]);
    return {
      frozen,
      keyActive: key.active,
      canBatchSwap: key.canBatchSwap,
      keyExpiry: key.expiry,
      keyNonce: key.nonce,
      balance,
      tokenInAllowed,
      tokenOutAllowed,
    };
  }
}
