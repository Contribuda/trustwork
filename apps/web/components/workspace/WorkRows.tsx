import NextLink from '@/components/locale/LocalLink';
import { AlertCircle, ArrowUpRight } from 'lucide-react';
import { KindBadge, StatusChip } from '@/components/ui';
import { DateTile } from '@/components/workspace/ProjectRow';
import { leadStatusLabel, rfqStatusLabel } from '@/components/workspace/parts';
import type { LeadRow, MyPublicationRow, RfqRow } from '@/app/_lib/data';
import { shortDate, t, tDynamic } from '@/app/_lib/i18n';
import { typo } from '@/app/_lib/typo';

export const RFQ_STAGES = {
  draft: ['needDraft', 'clarifying'],
  open: ['published'],
  compare: ['quotesCollected', 'negotiating', 'termsSelected'],
  order: ['orderPlaced', 'supplierAccepted', 'fulfilling'],
  done: ['partiallyAccepted', 'accepted', 'reviewed', 'closed'],
  problem: ['disputed', 'expired', 'cancelled'],
} as const;
export type RfqStage = keyof typeof RFQ_STAGES;

export function rfqStage(status: string): RfqStage {
  return ((Object.keys(RFQ_STAGES) as RfqStage[]).find((k) => (RFQ_STAGES[k] as readonly string[]).includes(status)) ?? 'draft') as RfqStage;
}

function stageTone(stage: RfqStage): 'warning' | 'info' | 'success' | 'neutral' {
  return stage === 'problem' ? 'warning' : stage === 'compare' || stage === 'order' ? 'info' : stage === 'done' ? 'success' : 'neutral';
}

/** Procurement row: what is being bought, where it stands, who runs it, and whether a decision waits. */
export function RfqListRow({ row, projectHref }: { row: RfqRow; projectHref: string | null }) {
  const stage = rfqStage(row.status);
  return (
    <li className={`ws-row${row.needsDecision ? ' ws-row--attention' : ''}`}>
      <span className="ws-row__main">
        <span className="ws-row__meta">
          <KindBadge kind={row.kind} size="sm" />
          <StatusChip size="sm" tone={row.needsDecision ? 'warning' : stageTone(stage)}>
            {rfqStatusLabel(row.status)}
          </StatusChip>
          <span>{t('procurement.versionShort', { version: row.version })}</span>
        </span>
        <span className="ws-row__title">{typo(row.title)}</span>
        <span className="ws-row__meta">
          {row.projectName ? projectHref ? <NextLink href={projectHref}>{typo(row.projectName)}</NextLink> : <span>{typo(row.projectName)}</span> : <span>{t('procurement.noProject')}</span>}
          <span>{row.ownerKind === 'person' ? t('procurement.ownerPerson') : t('procurement.ownerCompany')}</span>
          <span>
            {t('procurement.col.operator')}: {row.operator}
          </span>
          <span>
            {t('procurement.col.quotes')}: {row.quotesCount}
          </span>
        </span>
        {row.needsDecision ? (
          <span className="ws-row__banner">
            <AlertCircle size={13} strokeWidth={2} aria-hidden="true" /> {t('procurement.needsDecision')}
          </span>
        ) : null}
      </span>
      <span className="ws-row__side">
        <DateTile date={row.deadline} tone={row.needsDecision ? 'warn' : 'default'} />
        <span>{t('procurement.deadlineShort', { date: shortDate(row.deadline) })}</span>
      </span>
    </li>
  );
}

/** Sales lead row: the buyer's request, its source and where the quote stands. */
export function LeadListRow({ row }: { row: LeadRow }) {
  const tone = row.needsDecision
    ? 'warning'
    : row.status === 'won'
      ? 'success'
      : row.status === 'lost' || row.status === 'expired'
        ? 'neutral'
        : row.status === 'negotiating' || row.status === 'sent'
          ? 'info'
          : 'neutral';
  return (
    <li className={`ws-row${row.needsDecision ? ' ws-row--attention' : ''}`}>
      <span className="ws-row__main">
        <span className="ws-row__meta">
          <StatusChip size="sm" tone={tone}>
            {leadStatusLabel(row.status)}
          </StatusChip>
          <span className="ws-chip ws-chip--sm">{t(`leadSource.${row.source}`)}</span>
        </span>
        <span className="ws-row__title">{typo(row.request)}</span>
        <span className="ws-row__meta">
          <span>
            {t('sales.col.buyer')}: <strong>{typo(row.buyer)}</strong>
          </span>
          <span>{row.quoteVersion ? t('sales.quoteVersion', { version: row.quoteVersion }) : t('sales.noQuote')}</span>
        </span>
        {row.needsDecision ? (
          <span className="ws-row__banner">
            <AlertCircle size={13} strokeWidth={2} aria-hidden="true" /> {t('sales.needsDecision')}
          </span>
        ) : null}
      </span>
      <span className="ws-row__side">
        <DateTile date={row.deadline} tone={row.needsDecision ? 'warn' : 'default'} />
        <span>{t('procurement.deadlineShort', { date: shortDate(row.deadline) })}</span>
      </span>
    </li>
  );
}

export function pubTone(status: MyPublicationRow['status']): 'success' | 'info' | 'warning' | 'neutral' {
  return status === 'published' || status === 'corrected' ? 'success' : status === 'in_review' || status === 'scheduled' ? 'info' : status === 'retracted' ? 'warning' : 'neutral';
}

/** Publication row: state first, then where it is shown. */
export function PublicationListRow({ row }: { row: MyPublicationRow }) {
  return (
    <li className="ws-row">
      <span className="ws-row__main">
        <span className="ws-row__meta">
          <StatusChip size="sm" tone={pubTone(row.status)}>
            {tDynamic(`pubState.${row.status}`, row.status, { date: shortDate(row.updatedAt) })}
          </StatusChip>
          <span>{tDynamic(`publications.format.${row.format}`, row.format)}</span>
          <span>{row.authorLabel}</span>
        </span>
        {row.href ? (
          <NextLink href={row.href} className="ws-row__title">
            {typo(row.title)}
          </NextLink>
        ) : (
          <span className="ws-row__title">{typo(row.title)}</span>
        )}
        {row.shownInKnown !== false ? <span className="ws-row__meta">
          <span>{t('publications.col.shownIn')}:</span>
          {row.shownIn.length ? (
            row.shownIn.map((s, i) => (
              <span key={i} className="ws-chip ws-chip--sm">
                {s.kind === 'issue' ? t('publications.shownIn.issue', { number: s.number ?? 0 }) : t(`publications.shownIn.${s.kind}`)}
              </span>
            ))
          ) : (
            <span>{t('publications.shownIn.nowhere')}</span>
          )}
        </span> : null}
      </span>
      <span className="ws-row__side">
        <span>{t('common.updated', { date: shortDate(row.updatedAt) })}</span>
        {row.href ? (
          <NextLink href={row.href} className="ws-row__action">
            {t('publications.openPublic')}
            <ArrowUpRight size={14} strokeWidth={2} aria-hidden="true" />
          </NextLink>
        ) : null}
      </span>
    </li>
  );
}
