import type { ProviderCapability } from '@trustwork/contracts/client';
import type { AdapterRef } from './facets.js';

/**
 * Adapters that exist in engine code and that a country-pack fact may reference (CTRY-002). A pack names an adapter
 * only when the code exists here (live or as a fake); everything else goes into `candidateAdapters` as a lead.
 * Adding an adapter to the engine adds its entry here in the same pull request, with the module that implements it.
 */
export type EngineAdapter = {
  readonly capability: ProviderCapability;
  readonly id: string;
  /** Workspace module that implements the adapter. */
  readonly module: string;
  /** What the adapter does without credentials; adapters never call out without an operator's key. */
  readonly withoutCredentials: 'fake' | 'not_run';
};

export const ENGINE_ADAPTERS: readonly EngineAdapter[] = [
  { capability: 'sanctions_list', id: 'us-consolidated-screening-list', module: '@trustwork/compliance', withoutCredentials: 'not_run' },
];

export function findAdapter(ref: AdapterRef, registry: readonly EngineAdapter[] = ENGINE_ADAPTERS): EngineAdapter | null {
  return registry.find((adapter) => adapter.id === ref.id && adapter.capability === ref.capability) ?? null;
}
