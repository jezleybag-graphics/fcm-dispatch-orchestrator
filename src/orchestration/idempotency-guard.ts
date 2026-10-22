/**
 * Bounded TTL in-memory idempotency cache.
 * Absorbs duplicate upstream webhook bursts within the configured window (e.g., 60,000ms)
 * before hitting database locks or burning FCM quota.
 */
export class InMemoryIdempotencyGuard {
  private readonly entries = new Map<string, number>();
  private readonly windowMs: number;

  constructor(windowMs: number) {
    if (windowMs <= 0 || !Number.isInteger(windowMs)) {
      throw new RangeError(`Idempotency windowMs must be a positive integer, got ${windowMs}`);
    }
    this.windowMs = windowMs;
  }

  /**
   * Attempts to acquire an execution lock for `key` at `nowMs`.
   * Returns `true` if acquired (first seen in window), `false` if duplicate within TTL.
   */
  public tryAcquire(key: string, nowMs: number): boolean {
    this.evictExpired(nowMs);

    const expiresAt = this.entries.get(key);
    if (expiresAt !== undefined && nowMs < expiresAt) {
      return false;
    }

    this.entries.set(key, nowMs + this.windowMs);
    return true;
  }

  public release(key: string): void {
    this.entries.delete(key);
  }

  private evictExpired(nowMs: number): void {
    for (const [k, expiresAt] of this.entries.entries()) {
      if (nowMs >= expiresAt) {
        this.entries.delete(k);
      }
    }
  }
}
