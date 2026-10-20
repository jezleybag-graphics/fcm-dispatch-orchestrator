export interface BackoffInput {
  readonly attemptIndex: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly jitterFactor: number;
  readonly retryAfterSeconds?: number;
}

/**
 * Pure function: Calculates retry delay using exponential backoff with full jitter,
 * while strictly honoring upstream HTTP 429 `Retry-After` headers as a minimum floor.
 *
 * `jitterFactor` (0.0 to 1.0) is passed explicitly so calculation logic remains a deterministic
 * pure function without hidden `Math.random()` side effects.
 */
export function calculateBackoffDelayMs(input: BackoffInput): number {
  if (input.attemptIndex < 0 || !Number.isInteger(input.attemptIndex)) {
    throw new RangeError(`attemptIndex must be a non-negative integer, got ${input.attemptIndex}`);
  }
  if (input.jitterFactor < 0 || input.jitterFactor > 1) {
    throw new RangeError(`jitterFactor must be between 0 and 1, got ${input.jitterFactor}`);
  }

  const exponentialCap = Math.min(
    input.maxBackoffMs,
    input.baseBackoffMs * Math.pow(2, input.attemptIndex)
  );

  // Full jitter spreads concurrent batch retries across the window to prevent thundering herd on 429 recovery.
  const jitteredDelayMs = Math.floor(exponentialCap * input.jitterFactor);

  if (input.retryAfterSeconds !== undefined && input.retryAfterSeconds > 0) {
    const serverFloorMs = Math.ceil(input.retryAfterSeconds * 1_000);
    return Math.max(serverFloorMs, jitteredDelayMs);
  }

  return jitteredDelayMs;
}

/**
 * Pure function: Determines whether an OAuth2 bearer token must be refreshed prior to starting
 * a multi-chunk dispatch batch to avoid mid-batch 401 failures.
 */
export function shouldProactivelyRefreshToken(
  tokenExpiresAtEpochMs: number,
  currentEpochMs: number,
  refreshBufferSeconds: number
): boolean {
  const bufferMs = refreshBufferSeconds * 1_000;
  return currentEpochMs + bufferMs >= tokenExpiresAtEpochMs;
}
