/** Every implemented API module participates in subject planning, even when its exporter is unavailable. */
export const PRIVACY_MODULE_INVENTORY = [
  'approval-routes', 'assistant', 'assistant-goals', 'billing', 'catalogue', 'communications', 'connections', 'consultations',
  'content', 'directory', 'execution', 'files', 'hubs', 'identity', 'jurisdiction', 'models', 'plans', 'platform-admin',
  'procurement', 'profiles', 'projects', 'providers', 'reputation', 'sales', 'screening', 'screening-gates', 'sources',
  'supplier-base', 'support', 'tasks', 'transactions', 'trust',
] as const;

/** Operator assistants can prepare this data only. It deliberately contains no approval or execution capability. */
export interface PrivacyResponseDraft {
  state: 'Draft'; requestId: string; inventory: typeof PRIVACY_MODULE_INVENTORY;
  unresolved: readonly { module: string; capability: 'export' | 'erase' | 'redact' | 'pseudonymize'; reason: string }[];
}
