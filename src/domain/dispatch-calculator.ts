import type {
  AppSurfaceRole,
  DeviceSessionRecord,
  DispatchPayload,
  FcmSendOutcome,
  TokenPruneDirective,
} from "../types/manifest.js";

/**
 * Pure function: Generates a deterministic composite idempotency key from a dispatch event.
 * Prevents duplicate push notifications when upstream webhooks retry the same state transition.
 */
export function computeIdempotencyFingerprint(payload: DispatchPayload): string {
  return `${payload.tenantId}:${payload.targetSurface}:${payload.eventType}:${payload.eventId}`;
}

/**
 * Pure function: Selects active device sessions strictly scoped to the target tenant and app surface.
 * Deduplicates by `deviceFingerprint` + `surfaceRole` so a staff member logged into both a
 * shared store tablet (kitchen_display) and a personal device (manager_console) receives
 * surface-appropriate dispatches without token collision or duplicate alerts on the same hardware.
 */
export function selectRoleIsolatedTargetSessions(
  sessions: readonly DeviceSessionRecord[],
  tenantId: string,
  targetSurface: AppSurfaceRole
): readonly DeviceSessionRecord[] {
  const seenHardwareKeys = new Set<string>();
  const isolated: DeviceSessionRecord[] = [];

  for (const session of sessions) {
    if (session.tenantId !== tenantId) continue;
    if (session.surfaceRole !== targetSurface) continue;
    if (session.status !== "active") continue;

    const hardwareSurfaceKey = `${session.deviceFingerprint}::${session.surfaceRole}`;
    if (seenHardwareKeys.has(hardwareSurfaceKey)) continue;

    seenHardwareKeys.add(hardwareSurfaceKey);
    isolated.push(session);
  }

  return isolated;
}

/**
 * Pure function: Partitions a list of target sessions into bounded batches (e.g., <= 100 tokens).
 * Keeps concurrent HTTP/2 dispatches within Edge Function execution budgets and FCM quota windows.
 */
export function chunkTokenBatches<T>(
  items: readonly T[],
  maxBatchSize: number
): readonly (readonly T[])[] {
  if (maxBatchSize <= 0 || !Number.isInteger(maxBatchSize)) {
    throw new RangeError(`maxBatchSize must be a positive integer, got ${maxBatchSize}`);
  }

  const batches: Array<readonly T[]> = [];
  for (let i = 0; i < items.length; i += maxBatchSize) {
    batches.push(items.slice(i, i + maxBatchSize));
  }
  return batches;
}

/**
 * Pure function: Produces surgical revocation directives for dead `UNREGISTERED` FCM tokens.
 *
 * CRITICAL RULE:
 * Never revoke tokens by `accountId` alone. When a staff member's personal device uninstalls
 * the manager app (triggering `UNREGISTERED`), pruning by `accountId` would wipe the live
 * store POS or Kitchen Display tablet logged in under the same staff account.
 * Revocation must be strictly scoped to the exact `deviceId` and `fcmToken`.
 */
export function deriveScopedTokenPruneDirectives(
  targetedSessions: readonly DeviceSessionRecord[],
  outcomes: readonly FcmSendOutcome[]
): readonly TokenPruneDirective[] {
  const sessionByDeviceId = new Map<string, DeviceSessionRecord>();
  for (const s of targetedSessions) {
    sessionByDeviceId.set(s.id, s);
  }

  const directives: TokenPruneDirective[] = [];
  for (const outcome of outcomes) {
    if (outcome.ok || outcome.errorCode !== "UNREGISTERED") {
      continue;
    }

    const matchedSession = sessionByDeviceId.get(outcome.deviceId);
    if (!matchedSession || matchedSession.fcmToken !== outcome.fcmToken) {
      continue;
    }

    directives.push({
      deviceIdToRevoke: matchedSession.id,
      fcmToken: matchedSession.fcmToken,
      accountId: matchedSession.accountId,
      surfaceRole: matchedSession.surfaceRole,
      reason: "UNREGISTERED",
    });
  }

  return directives;
}
