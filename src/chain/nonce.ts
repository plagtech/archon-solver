/** Anything that can report an account's transaction count (an ethers Provider, a SolverChain) */
export interface NonceSource {
  getTransactionCount(address: string, blockTag: 'pending' | 'latest'): Promise<number>;
}

/**
 * Hands out sequential nonces for the solver account without a round-trip per tx. The
 * counter is (re)loaded from the chain's pending nonce on first use and after any
 * nonce-related rejection. Callers must serialize allocate → broadcast (the submitter does).
 */
export class NonceManager {
  private next?: number;

  constructor(
    private readonly provider: NonceSource,
    private readonly address: string,
  ) {}

  async allocate(): Promise<number> {
    if (this.next === undefined) await this.resync();
    return this.next!++;
  }

  /** Give back the most recent nonce when its tx was never broadcast */
  release(nonce: number): void {
    if (this.next === nonce + 1) this.next = nonce;
  }

  async resync(): Promise<number> {
    this.next = await this.provider.getTransactionCount(this.address, 'pending');
    return this.next;
  }

  /** Nonce of the next transaction to be mined (txs below this are final) */
  async confirmed(): Promise<number> {
    return this.provider.getTransactionCount(this.address, 'latest');
  }
}
