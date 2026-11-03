import type { AgentExtensionManifest, ExtensionAction } from '../../packages/contracts/src/agent-extensions.js';

/** Synthetic manifests of the adapter the engine installs. No import of the worker or the harness, so crash cases can use them. */
export const lookup: ExtensionAction = {
  operation: 'lookup_permit', title: { en: 'Look up a permit' }, kind: 'commit', mandateKind: 'research', confirmation: 'mandate', contextKinds: ['project'],
  inputs: [{ name: 'permitNumber', type: 'text', required: true, maxLength: 40 }],
  dataClassesRead: ['public'], dataClassesSent: ['public'], privateDataClasses: [], sideEffects: ['external_call'], endpointHosts: ['permits.synthetic.example'], cost: { kind: 'none' }, acceptsUntrustedText: false,
};
/** `key` keeps suites apart. */
export function manifestOf(key: string, patch: Partial<AgentExtensionManifest> = {}): AgentExtensionManifest {
  return {
    schemaVersion: 1, key, title: { en: 'Synthetic permit lookup' }, actions: [lookup], requiredMandateKinds: ['research'], endpoints: [{ host: 'permits.synthetic.example', country: 'US', region: null }],
    adapter: { adapterId: 'synthetic_http', fakeAdapterId: 'synthetic_http_fake' }, safetySuite: { suiteId: `extension.${key}` }, route: { job: 'agent_reasoning' }, ...patch,
  };
}
