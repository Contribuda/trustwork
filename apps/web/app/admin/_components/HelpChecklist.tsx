'use client';

import { useEffect, useState } from 'react';
import { Checkbox } from '@trustwork/ui';

/**
 * A role checklist on the Help page. Marking an item done is a personal preference kept in this browser only
 * (screens.md HC-03); it is never sent anywhere and the page works without storage.
 */
export function HelpChecklist({ id, items }: { id: string; items: ReadonlyArray<{ id: string; label: string }> }) {
  const key = `trustwork.admin.help.${id}`;
  const [done, setDone] = useState<string[]>([]);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw) setDone((JSON.parse(raw) as unknown[]).filter((x): x is string => typeof x === 'string'));
    } catch {
      /* storage unavailable: start empty */
    }
  }, [key]);
  const toggle = (item: string, value: boolean) => {
    const next = value ? [...new Set([...done, item])] : done.filter((x) => x !== item);
    setDone(next);
    try {
      window.localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* storage unavailable: keep it for this visit */
    }
  };
  return (
    <ul className="admin-checklist">
      {items.map((item) => (
        <li key={item.id}>
          <Checkbox isSelected={done.includes(item.id)} onChange={(value) => toggle(item.id, value)}>
            {item.label}
          </Checkbox>
        </li>
      ))}
    </ul>
  );
}
