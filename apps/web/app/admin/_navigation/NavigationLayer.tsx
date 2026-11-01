'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ADMIN_SHELL_LOCALES, Button, Checkbox, CommandPalette, Dialog, KeyboardShortcuts, type AdminDestination } from '@trustwork/ui';
import { countryCode, t } from '@trustwork/ui/i18n';
import { writeLocaleCookies } from '@/components/locale/locale-cookies';
import { paletteResults, textEntryTarget, type NavigationCopy, type NavigationDestination } from './model';
import { useDevicePreferences } from './useDevicePreferences';
import s from './navigation.module.css';

export function NavigationLayer({ scope, copy, destinations, support, current, locale }: {
  scope: string; copy: NavigationCopy; destinations: (NavigationDestination & AdminDestination)[]; support: NavigationDestination | null; current: string; locale: string;
}) {
  const router = useRouter();
  const id = useId();
  const [overlay, setOverlay] = useState<'palette' | 'help' | 'preferences' | null>(null);
  const [query, setQuery] = useState('');
  const [saved, setSaved] = useState(false);
  const searchButton = useRef<HTMLButtonElement>(null);
  const sequence = useRef(0);
  const lastLocation = useRef(current);
  const { preferences, ready, refused, update } = useDevicePreferences(scope);
  const helpKey = preferences.shortcutSet === 'standard' ? '?' : 'h';
  const filterKey = preferences.shortcutSet === 'standard' ? '/' : 'f';

  function open(kind: typeof overlay) {
    if (kind && document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return;
    setQuery('');
    setOverlay(kind);
  }
  function navigate(destination: NavigationDestination) {
    setQuery('');
    setOverlay(null);
    router.push(destination.href);
    // Wait for the owning route; focus the destination rather than a removed dialog control.
  }
  useEffect(() => {
    if (refused) { setOverlay(null); setQuery(''); }
  }, [refused]);
  useEffect(() => {
    if (lastLocation.current === current) return;
    lastLocation.current = current;
    const focus = requestAnimationFrame(() => document.querySelector<HTMLElement>('#admin-main h1')?.focus());
    return () => cancelAnimationFrame(focus);
  }, [current]);
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 || refused) return;
      const editing = textEntryTarget(event.target);
      if ((event.ctrlKey !== event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
        if (editing && overlay !== 'palette') return;
        if (overlay === 'palette') { event.preventDefault(); setOverlay(null); setQuery(''); return; }
        if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return;
        event.preventDefault();
        setQuery('');
        setOverlay('palette');
        return;
      }
      if (!ready || !preferences.singleKeys || editing || overlay || event.ctrlKey || event.metaKey || event.altKey || document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) { sequence.current = 0; return; }
      if (event.key === helpKey) { event.preventDefault(); setOverlay('help'); return; }
      if (event.key === filterKey) {
        const filter = document.querySelector<HTMLElement>('[data-console-filter]');
        if (filter) { event.preventDefault(); filter.focus(); }
        return;
      }
      if (event.key === 'g' && !event.shiftKey) { sequence.current = Date.now(); return; }
      const second = sequence.current && Date.now() - sequence.current < 1000;
      sequence.current = 0;
      if (!second || event.shiftKey) return;
      const target = { o: 'home:overview', i: 'home:inbox', a: 'staff:audit' }[event.key];
      const destination = destinations.find((d) => d.id === target);
      if (destination) { event.preventDefault(); navigate(destination); }
    }
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [destinations, ready, refused, overlay, preferences.singleKeys, helpKey, filterKey, router]);

  const shortcuts = [
    { id: 'palette', keys: 'Ctrl / Cmd + K', description: copy.commands },
    { id: 'help', keys: helpKey, description: copy.shortcuts },
    { id: 'filter', keys: filterKey, description: copy.filterHelp },
    ...([['o', 'home:overview'], ['i', 'home:inbox'], ['a', 'staff:audit']] as const).flatMap(([key, target]) => {
      const destination = destinations.find((d) => d.id === target);
      return destination ? [{ id: target, keys: `g ${key}`, description: destination.label }] : [];
    }),
  ];
  return <div className={s.tools} data-testid="console-navigation-tools" onKeyDownCapture={(event) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) event.stopPropagation();
  }}>
    <Button ref={searchButton} variant="secondary" onPress={() => open('palette')} aria-keyshortcuts="Control+k Meta+k">{copy.commands}</Button>
    <Button variant="secondary" onPress={() => open('help')}>{copy.shortcuts}</Button>
    <Button variant="secondary" onPress={() => open('preferences')}>{copy.preferences}</Button>
    <span className={s.location}>{copy.location}: {current}</span>
    <CommandPalette isOpen={overlay === 'palette'} enableShortcut={false} onOpenChange={(isOpen) => { if (!isOpen) { setOverlay(null); setQuery(''); } }} query={query} onQueryChange={setQuery}
      commands={paletteResults(query, destinations, support).map((destination) => ({ ...destination, group: destination.id === 'support-lookup' ? copy.privacyNote : destination.kind === 'command' ? copy.forms : destination.kind === 'help' ? copy.help : copy.sections, onSelect: () => navigate(destination) }))} />
    <KeyboardShortcuts isOpen={overlay === 'help'} onOpenChange={(isOpen) => { if (!isOpen) setOverlay(null); }} shortcuts={shortcuts} singleKeysEnabled={preferences.singleKeys && !refused} onSingleKeysChange={(singleKeys) => update({ ...preferences, singleKeys })} />
    <Dialog title={copy.preferences} isOpen={overlay === 'preferences'} onOpenChange={(isOpen) => { if (!isOpen) setOverlay(null); }}>
      <div className={s.stack}>
    <label className={s.language} htmlFor={`${id}-language`}>
      <span>{t('consoleKit.language')}</span>
      <select id={`${id}-language`} value={locale} onChange={(event) => { writeLocaleCookies(countryCode(), event.target.value); router.refresh(); }}>
        {ADMIN_SHELL_LOCALES.map((tag) => <option key={tag} value={tag}>{t(`adminShell.languages.${tag}`)}</option>)}
      </select>
    </label>
        <p>{copy.deviceNote}</p>
        <p>{copy.privacyNote} {copy.noHistory}</p>
        <Checkbox isDisabled={!ready || refused} isSelected={preferences.singleKeys} onChange={(singleKeys) => setSaved(update({ ...preferences, singleKeys }))}>{copy.singleKeys}</Checkbox>
        <label htmlFor={`${id}-keys`}>{copy.shortcutSet}</label>
        <select id={`${id}-keys`} disabled={!ready || refused} value={preferences.shortcutSet} onChange={(event) => setSaved(update({ ...preferences, shortcutSet: event.target.value === 'alternative' ? 'alternative' : 'standard' }))}>
          <option value="standard">{copy.standard} (? /)</option><option value="alternative">{copy.alternative} (h f)</option>
        </select>
        <p>{copy.shortcutNote}</p>
        <h2>{copy.notifications}</h2><p>{copy.notificationsNote}</p>
        <label htmlFor={`${id}-notifications`}>{copy.notifications}</label>
        <select id={`${id}-notifications`} disabled={!ready || refused} value={preferences.notifications} onChange={(event) => setSaved(update({ ...preferences, notifications: event.target.value as 'all' | 'approvals' | 'none' }))}>
          <option value="all">{copy.all}</option><option value="approvals">{copy.approvalsOnly}</option><option value="none">{copy.none}</option>
        </select>
        <label htmlFor={`${id}-quiet`}>{copy.quietHours}</label>
        <select id={`${id}-quiet`} disabled={!ready || refused} value={preferences.quietHours} onChange={(event) => setSaved(update({ ...preferences, quietHours: event.target.value === 'night' ? 'night' : 'off' }))}>
          <option value="off">{copy.off}</option><option value="night">{copy.night}</option>
        </select>
        <p role="status">{refused ? copy.notStored : saved ? copy.savedDevice : ''}</p>
      </div>
    </Dialog>
  </div>;
}
