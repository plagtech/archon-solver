export type IntentStatus = 'pending' | 'matched' | 'settling' | 'settled' | 'refunded' | 'expired' | 'failed';

/** An intent as submitted to POST /intent, after parsing */
export interface SignedIntent {
  vault: string;
  sessionKey: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  minAmountOut: bigint;
  deadline: number;
  nonce: number;
  signature: string;
}

export interface PendingIntent extends SignedIntent {
  /** keccak256 of the signed intent (see intentId()) */
  id: string;
  receivedAt: number;
  status: IntentStatus;
  /** Why the intent last failed to make it into a batch, if it did */
  lastExclusion?: string;
  /** Output the matcher expects the intent to receive in the current plan */
  expectedOut?: bigint;
  txHash?: string;
  /** Output delivered on-chain (IntentFilled.amountOut) */
  amountOut?: bigint;
  batchId?: bigint;
  /** Submissions that failed for a reason not attributable to a specific leg */
  attempts?: number;
}

/** Sorted token addresses, "0xlower-0xhigher" */
export type PairKey = `${string}-${string}`;

/** IntentEngine.BatchIntent, in ABI field order */
export interface BatchIntentStruct {
  vault: string;
  sessionKey: string;
  tokenIn: string;
  amountIn: bigint;
  minAmountOut: bigint;
  deadline: bigint;
  nonce: bigint;
  signature: string;
}
