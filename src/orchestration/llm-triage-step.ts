import type { AppSurfaceRole, ClientManifest } from "../types/manifest.js";

export interface RawOperationalSignal {
  readonly signalId: string;
  readonly source: "webhook_order_note" | "inventory_variance" | "seller_review";
  readonly rawText: string;
}

export interface StructuredTriageDecision {
  readonly signalId: string;
  readonly targetSurface: AppSurfaceRole;
  readonly urgencyScore: number;
  readonly confidence: number;
  readonly actionableSummary: string;
  readonly modelUsed: string;
  readonly escalatedToHeavyTier: boolean;
}

export interface LlmInferencePort {
  readonly runStructuredTriage: (
    modelId: string,
    signal: RawOperationalSignal
  ) => Promise<{
    readonly targetSurface: AppSurfaceRole;
    readonly urgencyScore: number;
    readonly confidence: number;
    readonly actionableSummary: string;
  }>;
}

/**
 * Executes an LLM as a deterministic pipeline step rather than an open-ended chatbot.
 * Routes predictable extraction to the fast model tier (e.g., gemini-3.8-flash / claude-sonnet-5.5)
 * and only escalates to the heavy reasoning tier (claude-opus-5.5 / gemini-4-argon) when confidence
 * drops below the client manifest's strict threshold.
 */
export async function executeTieredSignalTriage(
  manifest: ClientManifest,
  signal: RawOperationalSignal,
  llmPort: LlmInferencePort
): Promise<StructuredTriageDecision> {
  const { fastModelId, heavyModelId, anomalyConfidenceThreshold } = manifest.llmRouting;

  const fastPass = await llmPort.runStructuredTriage(fastModelId, signal);

  if (fastPass.confidence >= anomalyConfidenceThreshold) {
    return {
      signalId: signal.signalId,
      targetSurface: fastPass.targetSurface,
      urgencyScore: fastPass.urgencyScore,
      confidence: fastPass.confidence,
      actionableSummary: fastPass.actionableSummary,
      modelUsed: fastModelId,
      escalatedToHeavyTier: false,
    };
  }

  const heavyPass = await llmPort.runStructuredTriage(heavyModelId, signal);
  return {
    signalId: signal.signalId,
    targetSurface: heavyPass.targetSurface,
    urgencyScore: heavyPass.urgencyScore,
    confidence: heavyPass.confidence,
    actionableSummary: heavyPass.actionableSummary,
    modelUsed: heavyModelId,
    escalatedToHeavyTier: true,
  };
}
