'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Progressive wrapper for a row of native `<details>` dropdowns: only one stays open, a click outside or Escape
 * closes them. Without JavaScript every dropdown still opens and its links still filter (server-rendered).
 */
export function FilterBar({ children, label }: { children: ReactNode; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const all = () => Array.from(root.querySelectorAll<HTMLDetailsElement>('details.ev-dd'));
    const closeAll = (except?: HTMLDetailsElement) => all().forEach((d) => d !== except && d.open && (d.open = false));
    const onToggle = (e: Event) => {
      const el = e.target as HTMLDetailsElement;
      if (el.open) closeAll(el);
    };
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!root.contains(target) || target.closest('.ev-dd__close')) closeAll();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeAll();
    };
    root.addEventListener('toggle', onToggle, true);
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      root.removeEventListener('toggle', onToggle, true);
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, []);
  return (
    <div className="ev-filters" ref={ref} role="group" aria-label={label}>
      {children}
    </div>
  );
}
