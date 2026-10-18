export type AppSurfaceRole =
  | "pos_terminal"
  | "kitchen_display"
  | "manager_console"
  | "rider_dispatcher"
  | "customer_storefront";

export type TokenHealthStatus = "active" | "unregistered" | "quarantined";

export interface ClientManifest {
  readonly tenantId: string;
  readonly supabaseUrl: string;
  readonly supabaseServiceRoleKey: string;
  readonly fcmProjectId: string;
  readonly maxBatchSize: number;
  readonly idempotencyWindowMs: number;
  readonly maxRetryAttempts: number;
  readonly baseBackoffMs: number;
  readonly tokenRefreshBufferSeconds: number;
  readonly dryRun: boolean;
  readonly llmRouting: {
    readonly fastModelId: "gemini-3.8-flash" | "claude-sonnet-5.5";
    readonly heavyModelId: "claude-opus-5.5" | "gemini-4-argon";
    readonly anomalyConfidenceThreshold: number;
  };
}

export interface DeviceSessionRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly deviceFingerprint: string;
  readonly surfaceRole: AppSurfaceRole;
  readonly fcmToken: string;
  readonly status: TokenHealthStatus;
}

export interface DispatchPayload {
  readonly tenantId: string;
  readonly eventId: string;
  readonly eventType: "order_placed" | "kitchen_ready" | "rider_assigned" | "stock_critical";
  readonly targetSurface: AppSurfaceRole;
  readonly title: string;
  readonly body: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export type FcmErrorCode =
  | "UNREGISTERED"
  | "INVALID_ARGUMENT"
  | "QUOTA_EXCEEDED"
  | "UNAVAILABLE"
  | "INTERNAL";

export interface FcmSendOutcome {
  readonly fcmToken: string;
  readonly deviceId: string;
  readonly ok: boolean;
  readonly errorCode?: FcmErrorCode;
  readonly retryAfterSeconds?: number;
}

export interface TokenPruneDirective {
  readonly deviceIdToRevoke: string;
  readonly fcmToken: string;
  readonly accountId: string;
  readonly surfaceRole: AppSurfaceRole;
  readonly reason: "UNREGISTERED";
}

export interface DispatchExecutionSummary {
  readonly idempotencyKey: string;
  readonly skippedAsDuplicate: boolean;
  readonly dryRun: boolean;
  readonly targetedCount: number;
  readonly batchCount: number;
  readonly deliveredCount: number;
  readonly pruneDirectives: readonly TokenPruneDirective[];
}
