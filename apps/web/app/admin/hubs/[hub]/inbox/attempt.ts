import type { PreferenceStorage } from '../../../_navigation/preferences.js';

export type Attempt = { id: string; state: 'pending' | 'unknown' };
/** Synthetic transport correlation only. No command, reason, participant data, digest or credential is stored. */
export function readAttempt(storage: PreferenceStorage, key: string): Attempt | null {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as Attempt;
    if (!/^[a-f0-9-]{36}$/.test(value.id) || !['pending', 'unknown'].includes(value.state) || Object.keys(value).sort().join(',') !== 'id,state') return { id: '00000000-0000-0000-0000-000000000000', state: 'unknown' };
    return { ...value, state: 'unknown' };
  } catch { return { id: '00000000-0000-0000-0000-000000000000', state: 'unknown' }; }
}

export async function runAttempt(storage: PreferenceStorage, key: string, id: string, send: () => Promise<unknown>): Promise<boolean> {
  if (readAttempt(storage, key)) return false;
  // Record before dispatch: a refresh, a lost response or a second click must not replay the attempt.
  storage.setItem(key, JSON.stringify({ id, state: 'pending' } satisfies Attempt));
  await send();
  storage.removeItem(key);
  return true;
}
