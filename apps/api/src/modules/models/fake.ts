import type { ModelAdapter, ModelAdapterResult } from './ports.js';

/** Deterministic, synthetic, network-free adapter. It never records prompts or response bodies. */
export class DeterministicModel implements ModelAdapter {
  readonly mode = 'fake' as const;
  readonly calls: { operationId: string; modelRevision: string }[] = [];
  readonly lookups: string[] = [];
  async invoke(input: Parameters<ModelAdapter['invoke']>[0]): Promise<ModelAdapterResult> {
    this.calls.push({ operationId: input.operationId, modelRevision: input.model.modelRevision });
    return { kind: 'succeeded', text: 'Synthetic model response.', costMinorUnits: '0', inputTokens: 1, outputTokens: 1 };
  }
  async reconcile(operationId: string): Promise<ModelAdapterResult> {
    this.lookups.push(operationId);
    // An empty process has no evidence of another process's receipt; absence is never proof of no effect.
    return { kind: 'unknown' };
  }
}
