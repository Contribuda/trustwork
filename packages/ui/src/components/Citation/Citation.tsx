import type { ReactNode } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { AlertCircle, CheckCircle2, CircleHelp, Clock, History, Info, SearchX, TriangleAlert, WifiOff } from 'lucide-react';
import { cx } from '../../utils/cx';
import { formatDate, t } from '../../i18n';
import { Icon } from '../Icon/Icon';
import { EvidenceLabel, type EvidenceState } from '../Badge/Badge';
import { Button } from '../Button/Button';
import { Link } from '../Link/Link';
import styles from './Citation.module.css';

const toneClass = (tone: string) => `tone${tone.charAt(0).toUpperCase()}${tone.slice(1)}`;

export type CitationUnavailableReason = 'revoked' | 'deleted' | 'consent' | 'scope';

export type CitationChipState = { kind: 'available' } | { kind: 'historical'; date: string } | { kind: 'unavailable'; reason: CitationUnavailableReason };

export type CitationChipProps = {
  index: number;
  state?: CitationChipState | undefined;
  /** Whether the citation drawer is open (`aria-expanded`). */
  isExpanded?: boolean | undefined;
  onPress?: (() => void) | undefined;
  /** Id of the element describing the source (drawer heading) for `aria-describedby`. */
  describedBy?: string | undefined;
  className?: string | undefined;
};

/** Numbered citation chip: a button with `aria-expanded`; stays numbered when unavailable and says so in text. */
export function CitationChip({ index, state = { kind: 'available' }, isExpanded = false, onPress, describedBy, className }: CitationChipProps) {
  const suffix = state.kind === 'unavailable' ? `, ${t('citation.unavailableShort')}` : state.kind === 'historical' ? `, ${t('citation.historicalShort')}` : '';
  return (
    <AriaButton
      className={cx(styles.chip, styles[state.kind], className)}
      aria-label={`${t('citation.open', { index })}${suffix}`}
      aria-expanded={isExpanded}
      {...(describedBy ? { 'aria-describedby': describedBy } : {})}
      {...(onPress ? { onPress } : {})}
    >
      <span aria-hidden="true">[{index}]</span>
      {state.kind === 'unavailable' ? <Icon icon={AlertCircle} size={12} /> : state.kind === 'historical' ? <Icon icon={History} size={12} /> : null}
    </AriaButton>
  );
}

export type AnswerStatus = 'supported' | 'qualified' | 'abstain';

export type AnswerStatusLineProps = { status: AnswerStatus; reason?: string | undefined; scopeIncomplete?: boolean | undefined; className?: string | undefined };

const answerMeta = {
  supported: { icon: CheckCircle2, tone: 'success' },
  qualified: { icon: TriangleAlert, tone: 'warning' },
  abstain: { icon: CircleHelp, tone: 'neutral' },
} as const;

/** Derived-answer status (supported / qualified / abstain) as text with icon; `role="status"`. */
export function AnswerStatusLine({ status, reason, scopeIncomplete = false, className }: AnswerStatusLineProps) {
  const text = status === 'supported' ? t('answer.supported') : status === 'qualified' ? t('answer.qualified', { reason: reason ?? '' }) : t('answer.abstain');
  return (
    <p role="status" className={cx(styles.answer, styles[toneClass(answerMeta[status].tone)], className)}>
      <Icon icon={answerMeta[status].icon} size={20} />
      <span>
        <span className={styles.answerLabel}>{t('answer.statusLabel')}: </span>
        {text}
        {scopeIncomplete ? <span className={styles.scope}> · {t('answer.scopeIncomplete')}</span> : null}
      </span>
    </p>
  );
}

export type RetrievalStatus = 'complete' | 'partial' | 'noAnswer' | 'unavailable' | 'stale' | 'previousShown' | 'historical' | 'offline';

export type RetrievalStatusBannerProps = {
  status: RetrievalStatus;
  /** Reason key for `partial`. */
  reason?: 'budget' | 'sourcesUnavailable' | 'semanticOff' | undefined;
  /** ISO date for `historical`. */
  date?: string | undefined;
  onRetry?: (() => void) | undefined;
  onBackToCurrent?: (() => void) | undefined;
  className?: string | undefined;
};

const retrievalMeta = {
  complete: { icon: CheckCircle2, tone: 'success' },
  partial: { icon: Info, tone: 'info' },
  noAnswer: { icon: SearchX, tone: 'neutral' },
  unavailable: { icon: AlertCircle, tone: 'danger' },
  stale: { icon: Clock, tone: 'warning' },
  previousShown: { icon: Clock, tone: 'warning' },
  historical: { icon: History, tone: 'info' },
  offline: { icon: WifiOff, tone: 'warning' },
} as const;

/** Search/retrieval state banner (`role="status"`): complete / partial / no answer / unavailable / stale / historical. Never names a missing source. */
export function RetrievalStatusBanner({ status, reason, date, onRetry, onBackToCurrent, className }: RetrievalStatusBannerProps) {
  if (status === 'complete') return null;
  const text =
    status === 'partial'
      ? t('search.status.partial', { reason: t(`search.reason.${reason ?? 'sourcesUnavailable'}`) })
      : status === 'historical'
        ? t('search.historicalLabel', { date: formatDate(date ?? new Date()) })
        : status === 'offline'
          ? t('common.offline')
          : t(`search.status.${status}`);
  return (
    <div role="status" className={cx(styles.banner, styles[toneClass(retrievalMeta[status].tone)], className)}>
      <Icon icon={retrievalMeta[status].icon} size={20} />
      <span className={styles.bannerText}>{text}</span>
      {onRetry && (status === 'unavailable' || status === 'stale' || status === 'previousShown') ? (
        <Button size="sm" variant="secondary" onPress={onRetry}>
          {t('common.retry')}
        </Button>
      ) : null}
      {onBackToCurrent && status === 'historical' ? (
        <Button size="sm" variant="secondary" onPress={onBackToCurrent}>
          {t('search.backToCurrent')}
        </Button>
      ) : null}
    </div>
  );
}

export type CitationLocator = { kind: 'page'; page: number } | { kind: 'table'; page: number; table: string; row: string } | { kind: 'text' };

export type CitationDetailsProps = {
  headingId: string;
  sourceTitle: string;
  sourceKind: string;
  version: string;
  date: string;
  projection?: string | undefined;
  locator: CitationLocator;
  evidence: EvidenceState;
  href?: string | undefined;
  unavailable?: CitationUnavailableReason | undefined;
  historical?: boolean | undefined;
  children?: ReactNode;
};

/** Body of the citation drawer: description list of the exact source version, locator and evidence state, or the unavailable notice. */
export function CitationDetails({ headingId, sourceTitle, sourceKind, version, date, projection, locator, evidence, href, unavailable, historical = false, children }: CitationDetailsProps) {
  const locatorText =
    locator.kind === 'page'
      ? t('citation.locator.page', { page: locator.page })
      : locator.kind === 'table'
        ? t('citation.locator.table', { page: locator.page, table: locator.table, row: locator.row })
        : t('citation.locator.text');
  return (
    <div className={styles.details}>
      <h2 id={headingId} tabIndex={-1} className={styles.detailsTitle}>
        {t('citation.title')}: {sourceTitle}
      </h2>
      {unavailable ? (
        <div role="status" className={cx(styles.banner, styles.toneDanger)}>
          <Icon icon={AlertCircle} size={20} />
          <span className={styles.bannerText}>
            {t('citation.unavailable')}. {t(`citation.unavailableReason.${unavailable}`)}
          </span>
        </div>
      ) : null}
      {historical && !unavailable ? (
        <div role="status" className={cx(styles.banner, styles.toneInfo)}>
          <Icon icon={History} size={20} />
          <span className={styles.bannerText}>{t('search.historicalLabel', { date: formatDate(date) })}</span>
        </div>
      ) : null}
      <dl className={styles.dl}>
        <div>
          <dt>{sourceKind}</dt>
          <dd>{sourceTitle}</dd>
        </div>
        <div>
          <dt>{t('version.label')}</dt>
          <dd>{t('citation.version', { version, date: formatDate(date, 'short') })}</dd>
        </div>
        {projection ? (
          <div>
            <dt>{t('citation.projectionLabel')}</dt>
            <dd>{projection}</dd>
          </div>
        ) : null}
        <div>
          <dt>{t('citation.locatorLabel')}</dt>
          <dd>{locatorText}</dd>
        </div>
        <div>
          <dt>{t('citation.evidenceLabel')}</dt>
          <dd>
            <EvidenceLabel state={evidence} size="sm" />
          </dd>
        </div>
      </dl>
      {children}
      {href && !unavailable ? (
        <Link variant="standalone" href={href}>
          {t('citation.openSource')}
        </Link>
      ) : null}
    </div>
  );
}
