import { ArrowUpRight, Landmark } from 'lucide-react';
import type { RegisterFactView } from '@/app/_lib/data/types';
import { shortDate, t } from '@/app/_lib/i18n';
import { typo } from '@/app/_lib/typo';

/**
 * "From public registers" on a company page (REG-001). Each entry repeats what an official register showed, with the
 * date it was seen, its validity and a link to the register's own record; past `validUntil` it says so. A short
 * explanation tells how the entries are sourced. The panel never shows a badge, a score or "verified" wording, and it
 * is absent when there is nothing to show.
 */
const STATUSES = [
  'active', 'inactive', 'suspended', 'revoked', 'expired', 'dissolved', 'excluded', 'not_excluded', 'issued', 'lapsed', 'retired', 'annulled', 'pending_transfer',
  'pending_archival', 'merged', 'duplicate', 'open', 'closed',
] as const;
type Status = (typeof STATUSES)[number];

const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

export function factStatus(fact: Pick<RegisterFactView, 'value'>): Status | null {
  const raw = text(fact.value.status) ?? text(fact.value.registrationStatus);
  return raw !== null && (STATUSES as readonly string[]).includes(raw) ? (raw as Status) : null;
}

/** The secondary line of an entry: classes, grade or inspection details, from the register's own fields only. */
export function factDetail(fact: Pick<RegisterFactView, 'kind' | 'value'>): string | null {
  const v = fact.value;
  if (fact.kind === 'licence_status' && Array.isArray(v.classifications) && v.classifications.length > 0) {
    return t('companyPage.registerFacts.classes', { list: v.classifications.filter((c): c is string => typeof c === 'string').join(', ') });
  }
  if (fact.kind === 'official_rating' && text(v.scheme) && text(v.grade)) return t('companyPage.registerFacts.grade', { scheme: text(v.scheme) as string, grade: text(v.grade) as string });
  if (fact.kind === 'safety_inspection' && text(v.openedOn)) {
    const citations = typeof v.citations === 'number' ? ` · ${t('companyPage.registerFacts.citations', { count: v.citations })}` : '';
    return `${t('companyPage.registerFacts.opened', { date: shortDate(text(v.openedOn) as string) })}${citations}`;
  }
  return null;
}

export function RegisterFacts({ facts }: { facts: readonly RegisterFactView[] }) {
  if (facts.length === 0) return null;
  return (
    <section className="cp-section" id="registers" aria-labelledby="registers-title">
      <div className="cp-section__head">
        <h2 className="pub-h2 cp-section__title" id="registers-title">
          {t('companyPage.registerFacts.title')}
        </h2>
        <p className="cp-section__lede">{typo(t('companyPage.registerFacts.lede'))}</p>
      </div>
      <ul className="cp-certs">
        {facts.map((fact) => {
          const status = factStatus(fact);
          const detail = factDetail(fact);
          return (
            <li key={`${fact.kind}:${fact.link}`} className="cp-cert" data-stale={fact.stale ? 'true' : undefined}>
              <span className="cp-cert__text">
                <span className="cp-cert__name">
                  <span className="co-tag cp-cert__kind">{t(`companyPage.registerFacts.kind.${fact.kind}`)}</span>
                  {status ? ` ${t(`companyPage.registerFacts.status.${status}`)}` : ''}
                </span>
                <span className="cp-cert__meta">
                  {detail ? `${detail} · ` : ''}
                  {t('companyPage.registerFacts.observed', { date: shortDate(fact.observedAt) })}
                  {fact.validUntil ? ` · ${t('companyPage.registerFacts.validUntil', { date: shortDate(fact.validUntil) })}` : ''}
                </span>
                {fact.stale ? <span className="cp-cert__meta" role="note">{t('companyPage.registerFacts.stale')}</span> : null}
              </span>
              <a className="pub-more" href={fact.link} rel="noopener noreferrer nofollow" target="_blank">
                {t('companyPage.registerFacts.open')} <ArrowUpRight size={14} strokeWidth={1.75} aria-hidden="true" />
              </a>
            </li>
          );
        })}
      </ul>
      <details className="cp-faq__item">
        <summary>
          <Landmark size={16} strokeWidth={1.75} aria-hidden="true" /> {t('companyPage.registerFacts.how')}
        </summary>
        <p>{typo(t('companyPage.registerFacts.howBody'))}</p>
      </details>
    </section>
  );
}
