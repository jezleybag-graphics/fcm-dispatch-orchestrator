import type { ClientManifest } from "../types/manifest.js";

export class ManifestValidationError extends Error {
  public readonly field: string;

  constructor(field: string, reason: string) {
    super(`Manifest validation failed at [${field}]: ${reason}`);
    this.name = "ManifestValidationError";
    this.field = field;
  }
}

function requireNonEmptyString(raw: Record<string, unknown>, field: string): string {
  const val = raw[field];
  if (typeof val !== "string" || val.trim().length === 0) {
    throw new ManifestValidationError(
      field,
      "Required non-empty string is missing. Fallback defaults are strictly prohibited."
    );
  }
  return val.trim();
}

function requireIntegerInRange(
  raw: Record<string, unknown>,
  field: string,
  min: number,
  max: number
): number {
  const val = raw[field];
  if (typeof val !== "number" || !Number.isInteger(val) || val < min || val > max) {
    throw new ManifestValidationError(
      field,
      `Expected explicit integer between ${min} and ${max}, received ${String(val)}.`
    );
  }
  return val;
}

function requireBoolean(raw: Record<string, unknown>, field: string): boolean {
  const val = raw[field];
  if (typeof val !== "boolean") {
    throw new ManifestValidationError(
      field,
      `Expected explicit boolean, received ${typeof val}. Silent fallback to true/false is prohibited.`
    );
  }
  return val;
}

/**
 * Validates a raw client manifest with zero fallback values.
 * Every operational threshold and credential must be explicitly supplied by the caller.
 */
export function parseClientManifest(input: unknown): ClientManifest {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ManifestValidationError("root", "Manifest must be a non-null JSON object.");
  }

  const raw = input as Record<string, unknown>;

  const tenantId = requireNonEmptyString(raw, "tenantId");
  const supabaseUrl = requireNonEmptyString(raw, "supabaseUrl");
  if (!supabaseUrl.startsWith("https://")) {
    throw new ManifestValidationError("supabaseUrl", "Must use https:// protocol.");
  }

  const supabaseServiceRoleKey = requireNonEmptyString(raw, "supabaseServiceRoleKey");
  const fcmProjectId = requireNonEmptyString(raw, "fcmProjectId");

  // FCM v1 batch limit is capped at 100 tokens per concurrent chunk to stay within Edge execution budgets.
  const maxBatchSize = requireIntegerInRange(raw, "maxBatchSize", 1, 100);
  const idempotencyWindowMs = requireIntegerInRange(raw, "idempotencyWindowMs", 1_000, 300_000);
  const maxRetryAttempts = requireIntegerInRange(raw, "maxRetryAttempts", 0, 10);
  const baseBackoffMs = requireIntegerInRange(raw, "baseBackoffMs", 50, 30_000);
  const tokenRefreshBufferSeconds = requireIntegerInRange(raw, "tokenRefreshBufferSeconds", 30, 900);
  const dryRun = requireBoolean(raw, "dryRun");

  const llmRaw = raw["llmRouting"];
  if (typeof llmRaw !== "object" || llmRaw === null || Array.isArray(llmRaw)) {
    throw new ManifestValidationError("llmRouting", "Missing explicit llmRouting configuration block.");
  }
  const llmObj = llmRaw as Record<string, unknown>;

  const fastModelId = requireNonEmptyString(llmObj, "fastModelId");
  if (fastModelId !== "gemini-3.8-flash" && fastModelId !== "claude-sonnet-5.5") {
    throw new ManifestValidationError(
      "llmRouting.fastModelId",
      `Unsupported fast tier model: ${fastModelId}.`
    );
  }

  const heavyModelId = requireNonEmptyString(llmObj, "heavyModelId");
  if (heavyModelId !== "claude-opus-5.5" && heavyModelId !== "gemini-4-argon") {
    throw new ManifestValidationError(
      "llmRouting.heavyModelId",
      `Unsupported heavy tier model: ${heavyModelId}.`
    );
  }

  const threshold = llmObj["anomalyConfidenceThreshold"];
  if (typeof threshold !== "number" || Number.isNaN(threshold) || threshold <= 0 || threshold >= 1) {
    throw new ManifestValidationError(
      "llmRouting.anomalyConfidenceThreshold",
      "Expected explicit probability threshold strictly between 0 and 1."
    );
  }

  return Object.freeze({
    tenantId,
    supabaseUrl,
    supabaseServiceRoleKey,
    fcmProjectId,
    maxBatchSize,
    idempotencyWindowMs,
    maxRetryAttempts,
    baseBackoffMs,
    tokenRefreshBufferSeconds,
    dryRun,
    llmRouting: Object.freeze({
      fastModelId,
      heavyModelId,
      anomalyConfidenceThreshold: threshold,
    }),
  });
}
