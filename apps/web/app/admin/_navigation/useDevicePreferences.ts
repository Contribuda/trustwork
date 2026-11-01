'use client';

import { useEffect, useState } from 'react';
import { DEFAULT_PREFERENCES, PREFERENCE_KEY, loadPreferences, savePreferences, type DevicePreferences } from './preferences';

const UPDATED = 'console-navigation-preferences';
export function useDevicePreferences(scope: string) {
  const [preferences, setPreferences] = useState<DevicePreferences>(DEFAULT_PREFERENCES);
  const [ready, setReady] = useState(false);
  const [refused, setRefused] = useState(false);
  useEffect(() => {
    try { setPreferences(loadPreferences(window.localStorage, scope)); } catch { setRefused(true); }
    setReady(true);
    function sync() {
      try {
        const stored = JSON.parse(window.localStorage.getItem(PREFERENCE_KEY) ?? 'null') as { scope?: unknown } | null;
        if (stored?.scope !== scope) { setRefused(true); setPreferences(DEFAULT_PREFERENCES); return; }
        setPreferences(loadPreferences(window.localStorage, scope));
      } catch { setRefused(true); }
    }
    window.addEventListener('storage', sync);
    window.addEventListener(UPDATED, sync);
    return () => { window.removeEventListener('storage', sync); window.removeEventListener(UPDATED, sync); };
  }, [scope]);
  function update(next: DevicePreferences) {
    if (!ready || refused) return false;
    try {
      if (!savePreferences(window.localStorage, scope, next)) { setRefused(true); return false; }
      setPreferences(next);
      window.dispatchEvent(new Event(UPDATED));
      return true;
    } catch { setRefused(true); return false; }
  }
  return { preferences, ready, refused, update };
}
