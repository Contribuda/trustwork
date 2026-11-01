'use client';

import { useId } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@trustwork/ui';
import { withBase } from '@/app/_lib/base-path';
import { useDevicePreferences } from './useDevicePreferences';
import type { NavigationCopy, ViewId } from './model';
import s from './navigation.module.css';

/** The shared SavedViews free-name/query editor is deliberately not a persistence boundary. Only fixed IDs survive. */
export function SavedTabs({ scope, current, options, copy }: { scope: string; current: ViewId; options: { id: ViewId; label: string; href: string }[]; copy: NavigationCopy }) {
  const id = useId();
  const router = useRouter();
  const { preferences, ready, refused, update } = useDevicePreferences(scope);
  const saved = preferences.views.includes(current);
  return <section className={s.saved} aria-label={copy.savedViews}>
    <div className={s.filter}><label htmlFor={id}>{copy.filter}</label><select id={id} data-console-filter value={current} onChange={(event) => { const option = options.find((item) => item.id === event.target.value); if (option) router.push(option.href); }}>{options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></div>
    <div className={s.row}>
      <strong>{copy.savedViews}</strong>
      <Button variant="secondary" isDisabled={!ready || refused} onPress={() => update({ ...preferences, views: saved ? preferences.views.filter((view) => view !== current) : [...preferences.views, current] })}>{saved ? copy.removeView : copy.saveView}</Button>
      {options.filter((option) => preferences.views.includes(option.id)).map((option) => <a key={option.id} href={withBase(option.href)} aria-current={option.id === current ? 'page' : undefined}>{option.label}</a>)}
    </div>
    <p>{copy.viewsNote}</p>
    <p role="status">{refused ? copy.notStored : saved ? copy.savedDevice : ''}</p>
  </section>;
}
