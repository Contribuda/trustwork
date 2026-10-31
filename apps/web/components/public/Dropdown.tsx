import NextLink from 'next/link';
import { ChevronDown } from 'lucide-react';
import { t } from '@/app/_lib/i18n';

export type FacetItem = { label: string; n: number; active: boolean; to: string };

/**
 * Native dropdown for list filters (events, companies): works without JavaScript, the summary shows the chosen
 * value, options are links with counts. Wrap a row of them in `FilterBar` for one-open-at-a-time behaviour.
 */
export function Dropdown({ label, value, groups }: { label: string; value?: string | undefined; groups: Array<{ title?: string; items: FacetItem[] }> }) {
  return (
    <details className="ev-dd">
      <summary className="ev-dd__btn" aria-label={value ? `${label}: ${value}` : label} data-active={value ? 'true' : undefined}>
        <span className="ev-dd__label">{value ?? label}</span>
        <ChevronDown size={16} strokeWidth={2} aria-hidden="true" />
      </summary>
      <div className="ev-dd__panel">
        <div className="ev-dd__sheet-head">
          <span>{label}</span>
          <button type="button" className="ev-dd__close">
            {t('events.close')}
          </button>
        </div>
        {groups.map((g, gi) => (
          <div key={gi} className="ev-facet">
            {g.title ? <span className="ev-facet__title">{g.title}</span> : null}
            <ul className="ev-facet__list">
              {g.items.map((it) => (
                <li key={it.label}>
                  <NextLink href={it.to} className="ev-facet__item" aria-current={it.active ? 'true' : undefined} aria-disabled={it.n === 0 && !it.active ? 'true' : undefined} scroll={false}>
                    <span>{it.label}</span>
                    <span className="ev-facet__count">{it.n}</span>
                  </NextLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </details>
  );
}
