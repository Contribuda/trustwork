'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Tabs } from '@trustwork/ui';
import { t } from '@/app/_lib/i18n';

/**
 * Tabs whose panels are server-rendered nodes (company, person, project, my page, workspace project).
 * The tab list scrolls horizontally (with the design-system fade); when it overflows, a visible hint tells
 * the person that more tabs are reachable by scrolling or arrow keys.
 */
export function CompanyTabs({ tabs, label }: { tabs: Array<{ id: string; label: string; content: ReactNode }>; label: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const scroller = ref.current?.querySelector<HTMLElement>('[class*="scroller"]');
    if (!scroller) return;
    const check = () => setOverflows(scroller.scrollWidth > scroller.clientWidth + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [tabs.length]);
  return (
    <div ref={ref} className="tabs-wrap" data-overflows={overflows || undefined}>
      <Tabs aria-label={label} tabs={tabs} />
      {overflows ? <p className="tabs-wrap__hint">{t('ws.tabsScrollHint')}</p> : null}
    </div>
  );
}
