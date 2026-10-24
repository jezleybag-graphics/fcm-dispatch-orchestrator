import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ManifestValidationError,
  parseClientManifest,
} from "../src/config/manifest-validator.js";
import {
  chunkTokenBatches,
  deriveScopedTokenPruneDirectives,
  selectRoleIsolatedTargetSessions,
} from "../src/domain/dispatch-calculator.js";
import {
  calculateBackoffDelayMs,
  shouldProactivelyRefreshToken,
} from "../src/domain/backoff-policy.js";
import { FcmDispatchOrchestrator } from "../src/orchestration/fcm-orchestrator.js";
import { executeTieredSignalTriage } from "../src/orchestration/llm-triage-step.js";
import type {
  ClientManifest,
  DeviceSessionRecord,
  DispatchPayload,
} from "../src/types/manifest.js";

const VALID_SANDBOX_MANIFEST_RAW = {
  tenantId: "morpho-store-01",
  supabaseUrl: "https://sandbox-store.supabase.co",
  supabaseServiceRoleKey: "sb_service_role_sandbox_token_991",
  fcmProjectId: "morpho-commerce-fcm",
  maxBatchSize: 100,
  idempotencyWindowMs: 60_000,
  maxRetryAttempts: 3,
  baseBackoffMs: 200,
  tokenRefreshBufferSeconds: 120,
  dryRun: false,
  llmRouting: {
    fastModelId: "gemini-3.8-flash",
    heavyModelId: "claude-opus-5.5",
    anomalyConfidenceThreshold: 0.85,
  },
};

describe("Business Rule: Client manifests must fail fast rather than silently applying fallback values", () => {
  it("rejects manifests missing explicit dryRun or maxBatchSize to prevent unconfigured clients from silently executing against production defaults", () => {
    const { dryRun: _omitted, ...incompleteManifest } = VALID_SANDBOX_MANIFEST_RAW;

    assert.throws(
      () => parseClientManifest(incompleteManifest),
      (err: unknown) =>
        err instanceof ManifestValidationError && err.field === "dryRun"
    );
  });

  it("rejects batch sizes exceeding 100 tokens because larger concurrent HTTP/2 bursts exceed Edge Function wall-clock budgets", () => {
    assert.throws(
      () =>
        parseClientManifest({
          ...VALID_SANDBOX_MANIFEST_RAW,
          maxBatchSize: 250,
        }),
      (err: unknown) =>
        err instanceof ManifestValidationError && err.field === "maxBatchSize"
    );
  });
});

describe("Business Rule: Shared store tablets and personal phones under one staff account must never collide or cross-revoke", () => {
  const SANDBOX_SESSIONS: readonly DeviceSessionRecord[] = [
    {
      id: "dev-kds-tablet-01",
      tenantId: "morpho-store-01",
      accountId: "staff-shared-acct-77",
      deviceFingerprint: "hw-ipad-kitchen-counter",
      surfaceRole: "kitchen_display",
      fcmToken: "fcm_tok_kitchen_ipad_live",
      status: "active",
    },
    {
      id: "dev-mgr-phone-01",
      tenantId: "morpho-store-01",
      accountId: "staff-shared-acct-77",
      deviceFingerprint: "hw-iphone-manager-personal",
      surfaceRole: "manager_console",
      fcmToken: "fcm_tok_manager_phone_uninstalled",
      status: "active",
    },
    {
      id: "dev-kds-tablet-duplicate-reg",
      tenantId: "morpho-store-01",
      accountId: "staff-shared-acct-77",
      deviceFingerprint: "hw-ipad-kitchen-counter",
      surfaceRole: "kitchen_display",
      fcmToken: "fcm_tok_kitchen_ipad_stale_dup",
      status: "active",
    },
  ];

  it("isolates kitchen_display dispatches to kitchen hardware and deduplicates re-registrations on the same tablet", () => {
    const targets = selectRoleIsolatedTargetSessions(
      SANDBOX_SESSIONS,
      "morpho-store-01",
      "kitchen_display"
    );

    assert.equal(targets.length, 1);
    assert.equal(targets[0]?.id, "dev-kds-tablet-01");
  });

  it("scopes UNREGISTERED token revocation strictly to the dead personal phone so the shared store KDS tablet under the same staff account stays live", () => {
    const pruneDirectives = deriveScopedTokenPruneDirectives(SANDBOX_SESSIONS, [
      {
        deviceId: "dev-mgr-phone-01",
        fcmToken: "fcm_tok_manager_phone_uninstalled",
        ok: false,
        errorCode: "UNREGISTERED",
      },
      {
        deviceId: "dev-kds-tablet-01",
        fcmToken: "fcm_tok_kitchen_ipad_live",
        ok: true,
      },
    ]);

    assert.equal(pruneDirectives.length, 1);
    assert.equal(pruneDirectives[0]?.deviceIdToRevoke, "dev-mgr-phone-01");
    assert.equal(pruneDirectives[0]?.surfaceRole, "manager_console");
  });
});

describe("Business Rule: Rate-limit recovery and proactive OAuth token lifecycle must prevent mid-batch drops", () => {
  it("enforces upstream HTTP 429 Retry-After headers as a strict minimum floor even when random jitter rolls low", () => {
    const delayMs = calculateBackoffDelayMs({
      attemptIndex: 1,
      baseBackoffMs: 200,
      maxBackoffMs: 10_000,
      jitterFactor: 0.1, // Jitter alone would yield 40ms
      retryAfterSeconds: 4, // Upstream explicitly demanded a 4000ms cool-down
    });

    assert.equal(delayMs, 4_000);
  });

  it("triggers proactive OAuth2 token refresh before batch start when remaining token TTL falls inside the safety buffer", () => {
    const nowEpochMs = 1_700_000_000_000;
    const expiresIn90Sec = nowEpochMs + 90_000;

    // Buffer requires 120s headroom so a multi-chunk 100-token dispatch does not 401 mid-flight.
    assert.equal(
      shouldProactivelyRefreshToken(expiresIn90Sec, nowEpochMs, 120),
      true
    );
  });

  it("chunks 245 target sessions into 3 batches capped at 100 tokens each", () => {
    const fakeTokens = Array.from({ length: 245 }, (_, i) => `tok_${i}`);
    const batches = chunkTokenBatches(fakeTokens, 100);

    assert.equal(batches.length, 3);
    assert.equal(batches[0]?.length, 100);
    assert.equal(batches[1]?.length, 100);
    assert.equal(batches[2]?.length, 45);
  });
});

describe("Business Rule: Orchestrator must absorb duplicate webhook bursts within the 60s idempotency window and honor dry-run mode", () => {
  const SAMPLE_PAYLOAD: DispatchPayload = {
    tenantId: "morpho-store-01",
    eventId: "ord_99812_ready",
    eventType: "kitchen_ready",
    targetSurface: "rider_dispatcher",
    title: "Order #99812 Ready for Pickup",
    body: "Proceed to counter 2",
    metadata: { orderId: "99812" },
  };

  it("blocks duplicate webhook triggers within 60 seconds before hitting FCM or writing duplicate audit rows", async () => {
    const manifest: ClientManifest = parseClientManifest(VALID_SANDBOX_MANIFEST_RAW);
    let fcmCalls = 0;

    const orchestrator = new FcmDispatchOrchestrator(manifest, {
      nowEpochMs: () => 1_700_000_000_000,
      randomJitter: () => 0.5,
      sleepMs: async () => {},
      getOAuthToken: async () => ({
        accessToken: "oauth_live_tok",
        expiresAtEpochMs: 1_700_000_600_000,
      }),
      refreshOAuthToken: async () => ({
        accessToken: "oauth_refreshed_tok",
        expiresAtEpochMs: 1_700_003_600_000,
      }),
      fetchTenantSessions: async () => [
        {
          id: "dev-rider-01",
          tenantId: "morpho-store-01",
          accountId: "rider-acct-1",
          deviceFingerprint: "hw-android-rider-1",
          surfaceRole: "rider_dispatcher",
          fcmToken: "fcm_rider_1",
          status: "active",
        },
      ],
      sendFcmBatch: async (_token, batch) => {
        fcmCalls += 1;
        return batch.map((d) => ({
          deviceId: d.id,
          fcmToken: d.fcmToken,
          ok: true,
        }));
      },
      revokeUnregisteredDevices: async () => {},
      appendAuditJournal: async () => {},
    });

    const firstRun = await orchestrator.executeDispatch(SAMPLE_PAYLOAD);
    const duplicateRun = await orchestrator.executeDispatch(SAMPLE_PAYLOAD);

    assert.equal(firstRun.skippedAsDuplicate, false);
    assert.equal(firstRun.deliveredCount, 1);
    assert.equal(duplicateRun.skippedAsDuplicate, true);
    assert.equal(fcmCalls, 1);
  });

  it("computes exact target and batch counts in dryRun mode without touching external FCM endpoints or database mutations", async () => {
    const dryRunManifest = parseClientManifest({
      ...VALID_SANDBOX_MANIFEST_RAW,
      dryRun: true,
    });
    let sideEffectsTriggered = 0;

    const orchestrator = new FcmDispatchOrchestrator(dryRunManifest, {
      nowEpochMs: () => 1_700_000_000_000,
      randomJitter: () => 0.5,
      sleepMs: async () => {},
      getOAuthToken: async () => {
        sideEffectsTriggered += 1;
        return { accessToken: "unused", expiresAtEpochMs: 0 };
      },
      refreshOAuthToken: async () => ({ accessToken: "unused", expiresAtEpochMs: 0 }),
      fetchTenantSessions: async () => [
        {
          id: "dev-rider-01",
          tenantId: "morpho-store-01",
          accountId: "rider-acct-1",
          deviceFingerprint: "hw-android-rider-1",
          surfaceRole: "rider_dispatcher",
          fcmToken: "fcm_rider_1",
          status: "active",
        },
      ],
      sendFcmBatch: async () => {
        sideEffectsTriggered += 1;
        return [];
      },
      revokeUnregisteredDevices: async () => {
        sideEffectsTriggered += 1;
      },
      appendAuditJournal: async () => {
        sideEffectsTriggered += 1;
      },
    });

    const summary = await orchestrator.executeDispatch(SAMPLE_PAYLOAD);

    assert.equal(summary.dryRun, true);
    assert.equal(summary.targetedCount, 1);
    assert.equal(summary.batchCount, 1);
    assert.equal(sideEffectsTriggered, 0);
  });
});

describe("Business Rule: Tiered LLM pipeline preserves unit economics by escalating to Opus/Argon only when Flash confidence is below threshold", () => {
  it("completes routine operational triage on gemini-3.8-flash and only invokes claude-opus-5.5 on ambiguous signals", async () => {
    const manifest = parseClientManifest(VALID_SANDBOX_MANIFEST_RAW);
    const invokedModels: string[] = [];

    const mockPort = {
      runStructuredTriage: async (modelId: string) => {
        invokedModels.push(modelId);
        if (modelId === "gemini-3.8-flash") {
          return {
            targetSurface: "manager_console" as const,
            urgencyScore: 8,
            confidence: 0.62, // Below 0.85 threshold -> requires heavy reasoning escalation
            actionableSummary: "Ambiguous cold-chain variance reported across multiple SKUs.",
          };
        }
        return {
          targetSurface: "manager_console" as const,
          urgencyScore: 9,
          confidence: 0.96,
          actionableSummary: "Confirmed walk-in chiller compressor stall; immediate stock transfer required.",
        };
      },
    };

    const decision = await executeTieredSignalTriage(
      manifest,
      {
        signalId: "sig_441",
        source: "inventory_variance",
        rawText: "Temp sensor fluctuating between 4C and 11C on unit B after power dip",
      },
      mockPort
    );

    assert.deepEqual(invokedModels, ["gemini-3.8-flash", "claude-opus-5.5"]);
    assert.equal(decision.escalatedToHeavyTier, true);
    assert.equal(decision.modelUsed, "claude-opus-5.5");
  });
});
