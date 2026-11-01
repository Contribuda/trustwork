import { VIEW_IDS, type ViewId } from './model.js';

export const PREFERENCE_KEY = 'trustwork.console.navigation.v1';
export type DevicePreferences = { singleKeys: boolean; shortcutSet: 'standard' | 'alternative'; notifications: 'all' | 'approvals' | 'none'; quietHours: 'off' | 'night'; views: ViewId[] };
export const DEFAULT_PREFERENCES: DevicePreferences = { singleKeys: true, shortcutSet: 'standard', notifications: 'all', quietHours: 'off', views: [] };
export interface PreferenceStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

/** Reject rather than retain extra fields, arbitrary names, private filters, queries or identity payloads. */
export function parsePreferences(value: unknown): DevicePreferences | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  if (Object.keys(p).sort().join(',') !== 'notifications,quietHours,shortcutSet,singleKeys,views') return null;
  if (typeof p.singleKeys !== 'boolean' || !['standard', 'alternative'].includes(String(p.shortcutSet)) || !['all', 'approvals', 'none'].includes(String(p.notifications)) || !['off', 'night'].includes(String(p.quietHours))) return null;
  if (!Array.isArray(p.views) || p.views.length > VIEW_IDS.length || p.views.some((id) => !VIEW_IDS.includes(id)) || new Set(p.views).size !== p.views.length) return null;
  return p as DevicePreferences;
}

export function loadPreferences(storage: PreferenceStorage, scope: string): DevicePreferences {
  try {
    const raw = storage.getItem(PREFERENCE_KEY);
    const saved = raw ? JSON.parse(raw) as { scope?: unknown; preferences?: unknown } : null;
    const preferences = saved?.scope === scope ? parsePreferences(saved.preferences) : null;
    if (preferences && Object.keys(saved!).sort().join(',') === 'preferences,scope') return preferences;
    storage.removeItem(PREFERENCE_KEY);
    const fresh = { ...DEFAULT_PREFERENCES, views: [] };
    storage.setItem(PREFERENCE_KEY, JSON.stringify({ scope, preferences: fresh }));
    return fresh;
  } catch { return { ...DEFAULT_PREFERENCES, views: [] }; }
}

/** A stale tab cannot overwrite another viewer's preferences after an identity/hub change. */
export function savePreferences(storage: PreferenceStorage, scope: string, preferences: DevicePreferences): boolean {
  try {
    const current = JSON.parse(storage.getItem(PREFERENCE_KEY) ?? 'null') as { scope?: unknown } | null;
    if (current?.scope !== scope || !parsePreferences(preferences)) return false;
    storage.setItem(PREFERENCE_KEY, JSON.stringify({ scope, preferences }));
    return true;
  } catch { return false; }
}
