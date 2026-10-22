import type {
  ClientManifest,
  DeviceSessionRecord,
  DispatchExecutionSummary,
  DispatchPayload,
  FcmSendOutcome,
  TokenPruneDirective,
} from "../types/manifest.js";
import {
  chunkTokenBatches,
  computeIdempotencyFingerprint,
  deriveScopedTokenPruneDirectives,
  selectRoleIsolatedTargetSessions,
} from "../domain/dispatch-calculator.js";
import {
  calculateBackoffDelayMs,
  shouldProactivelyRefreshToken,
} from "../domain/backoff-policy.js";
import { InMemoryIdempotencyGuard } from "./idempotency-guard.js";

export interface OAuthTokenSnapshot {
  readonly accessToken: string;
  readonly expiresAtEpochMs: number;
}

export interface DispatchPorts {
  readonly nowEpochMs: () => number;
  readonly randomJitter: () => number;
  readonly sleepMs: (ms: number) => Promise<void>;
  readonly getOAuthToken: () => Promise<OAuthTokenSnapshot>;
  readonly refreshOAuthToken: () => Promise<OAuthTokenSnapshot>;
  readonly fetchTenantSessions: (tenantId: string) => Promise<readonly DeviceSessionRecord[]>;
  readonly sendFcmBatch: (
    accessToken: string,
    batch: readonly DeviceSessionRecord[],
    payload: DispatchPayload
  ) => Promise<readonly FcmSendOutcome[]>;
  readonly revokeUnregisteredDevices: (
    directives: readonly TokenPruneDirective[]
  ) => Promise<void>;
  readonly appendAuditJournal: (summary: DispatchExecutionSummary, payload: DispatchPayload) => Promise<void>;
}

export class FcmDispatchOrchestrator {
  private readonly manifest: ClientManifest;
  private readonly idempotencyGuard: InMemoryIdempotencyGuard;
  private readonly ports: DispatchPorts;

  constructor(manifest: ClientManifest, ports: DispatchPorts) {
    this.manifest = manifest;
    this.idempotencyGuard = new InMemoryIdempotencyGuard(manifest.idempotencyWindowMs);
    this.ports = ports;
  }

  public async executeDispatch(payload: DispatchPayload): Promise<DispatchExecutionSummary> {
    const idempotencyKey = computeIdempotencyFingerprint(payload);
    const nowMs = this.ports.nowEpochMs();

    if (!this.idempotencyGuard.tryAcquire(idempotencyKey, nowMs)) {
      return {
        idempotencyKey,
        skippedAsDuplicate: true,
        dryRun: this.manifest.dryRun,
        targetedCount: 0,
        batchCount: 0,
        deliveredCount: 0,
        pruneDirectives: [],
      };
    }

    const allSessions = await this.ports.fetchTenantSessions(this.manifest.tenantId);
    const targetSessions = selectRoleIsolatedTargetSessions(
      allSessions,
      this.manifest.tenantId,
      payload.targetSurface
    );
    const batches = chunkTokenBatches(targetSessions, this.manifest.maxBatchSize);

    // Dry-run mode computes exact targeting and batching without mutating production state or sending push alerts.
    if (this.manifest.dryRun) {
      return {
        idempotencyKey,
        skippedAsDuplicate: false,
        dryRun: true,
        targetedCount: targetSessions.length,
        batchCount: batches.length,
        deliveredCount: 0,
        pruneDirectives: [],
      };
    }

    let tokenSnapshot = await this.ports.getOAuthToken();
    if (
      shouldProactivelyRefreshToken(
        tokenSnapshot.expiresAtEpochMs,
        this.ports.nowEpochMs(),
        this.manifest.tokenRefreshBufferSeconds
      )
    ) {
      tokenSnapshot = await this.ports.refreshOAuthToken();
    }

    const allOutcomes: FcmSendOutcome[] = [];
    for (const batch of batches) {
      const batchOutcomes = await this.dispatchBatchWithRetry(
        tokenSnapshot.accessToken,
        batch,
        payload
      );
      allOutcomes.push(...batchOutcomes);
    }

    const pruneDirectives = deriveScopedTokenPruneDirectives(targetSessions, allOutcomes);
    if (pruneDirectives.length > 0) {
      await this.ports.revokeUnregisteredDevices(pruneDirectives);
    }

    const deliveredCount = allOutcomes.filter((o) => o.ok).length;
    const summary: DispatchExecutionSummary = {
      idempotencyKey,
      skippedAsDuplicate: false,
      dryRun: false,
      targetedCount: targetSessions.length,
      batchCount: batches.length,
      deliveredCount,
      pruneDirectives,
    };

    await this.ports.appendAuditJournal(summary, payload);
    return summary;
  }

  private async dispatchBatchWithRetry(
    accessToken: string,
    batch: readonly DeviceSessionRecord[],
    payload: DispatchPayload
  ): Promise<readonly FcmSendOutcome[]> {
    let pendingSessions: readonly DeviceSessionRecord[] = batch;
    const finalOutcomes = new Map<string, FcmSendOutcome>();

    for (let attempt = 0; attempt <= this.manifest.maxRetryAttempts; attempt++) {
      const outcomes = await this.ports.sendFcmBatch(accessToken, pendingSessions, payload);
      const retryableDeviceIds = new Set<string>();
      let maxRetryAfterSec: number | undefined;

      for (const outcome of outcomes) {
        const isTransientError =
          !outcome.ok &&
          (outcome.errorCode === "QUOTA_EXCEEDED" ||
            outcome.errorCode === "UNAVAILABLE" ||
            outcome.errorCode === "INTERNAL");

        if (isTransientError && attempt < this.manifest.maxRetryAttempts) {
          retryableDeviceIds.add(outcome.deviceId);
          if (outcome.retryAfterSeconds !== undefined) {
            maxRetryAfterSec =
              maxRetryAfterSec === undefined
                ? outcome.retryAfterSeconds
                : Math.max(maxRetryAfterSec, outcome.retryAfterSeconds);
          }
        } else {
          finalOutcomes.set(outcome.deviceId, outcome);
        }
      }

      if (retryableDeviceIds.size === 0) {
        break;
      }

      const delayMs = calculateBackoffDelayMs({
        attemptIndex: attempt,
        baseBackoffMs: this.manifest.baseBackoffMs,
        maxBackoffMs: 30_000,
        jitterFactor: this.ports.randomJitter(),
        ...(maxRetryAfterSec !== undefined ? { retryAfterSeconds: maxRetryAfterSec } : {}),
      });

      await this.ports.sleepMs(delayMs);
      pendingSessions = pendingSessions.filter((s) => retryableDeviceIds.has(s.id));
    }

    return Array.from(finalOutcomes.values());
  }
}
