import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  CheckCircle2,
  CircleDashed,
  CircleHelp,
  FileSearch,
  Megaphone,
  ShieldCheck,
  CircleAlert,
  History,
  Clock,
  CircleX,
  PauseCircle,
  PlayCircle,
  ListChecks,
  Lock,
  RotateCw,
  CircleCheck,
  Archive,
  FilePen,
} from 'lucide-react';
import { cx } from '../../utils/cx';
import { formatNumber, t } from '../../i18n';
import { Icon } from '../Icon/Icon';
import styles from './Badge.module.css';

/** Counts above this render as «99+» (a number, not product copy). */
const BADGE_MAX = 99;

export type BadgeProps = {
  /** Count; 0 hides the badge; above 99 shows «99+». */
  count?: number | undefined;
  /** Dot without a number when the count is unknown. */
  dot?: boolean | undefined;
  tone?: 'accent' | 'warning' | 'danger' | 'neutral' | undefined;
  className?: string | undefined;
};

/**
 * Count badge. Purely visual: the parent control must include the count in its accessible name
 * (for example «Уведомления, 3 новых»), so the badge is `aria-hidden`.
 */
export function Badge({ count, dot = false, tone = 'accent', className }: BadgeProps) {
  if (!dot && (count === undefined || count <= 0)) return null;
  return (
    <span aria-hidden="true" className={cx(styles.badge, dot && styles.dot, styles[tone], className)}>
      {dot ? null : count !== undefined && count > BADGE_MAX ? `${BADGE_MAX}+` : formatNumber(count ?? 0)}
    </span>
  );
}

export type StatusFamily = 'record' | 'evidence' | 'kind' | 'lifecycle' | 'run' | 'custom';
export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export type StatusChipProps = {
  /** Visible text; never rely on colour alone. */
  children: ReactNode;
  tone?: StatusTone | undefined;
  icon?: LucideIcon | undefined;
  size?: 'sm' | 'md' | undefined;
  className?: string | undefined;
};

/** Generic status chip: icon + text with a tone family. Prefer the typed helpers below. */
export function StatusChip({ children, tone = 'neutral', icon, size = 'md', className }: StatusChipProps) {
  return (
    <span className={cx(styles.chip, styles[`tone${tone.charAt(0).toUpperCase()}${tone.slice(1)}`], size === 'sm' && styles.chipSm, className)}>
      {icon ? <Icon icon={icon} size={16} /> : null}
      <span>{children}</span>
    </span>
  );
}

export type RecordStatus = 'sourced' | 'claimed' | 'verified';
const recordMeta: Record<RecordStatus, { tone: StatusTone; icon: LucideIcon }> = {
  sourced: { tone: 'neutral', icon: FileSearch },
  claimed: { tone: 'info', icon: Megaphone },
  verified: { tone: 'success', icon: ShieldCheck },
};

/** Sourced / claimed / verified record status — always distinct, always with text. */
export function RecordStatusChip({ status, size }: { status: RecordStatus; size?: 'sm' | 'md' | undefined }) {
  return (
    <StatusChip tone={recordMeta[status].tone} icon={recordMeta[status].icon} size={size}>
      {t(`status.${status}`)}
    </StatusChip>
  );
}

export type EvidenceState = 'asserted' | 'confirmed' | 'disputed' | 'superseded';
const evidenceMeta: Record<EvidenceState, { tone: StatusTone; icon: LucideIcon }> = {
  asserted: { tone: 'neutral', icon: CircleDashed },
  confirmed: { tone: 'success', icon: CheckCircle2 },
  disputed: { tone: 'warning', icon: CircleAlert },
  superseded: { tone: 'neutral', icon: History },
};

/** Evidence state label (asserted / confirmed / disputed / superseded) from the frozen retrieval vocabulary. */
export function EvidenceLabel({ state, size }: { state: EvidenceState; size?: 'sm' | 'md' | undefined }) {
  return (
    <StatusChip tone={evidenceMeta[state].tone} icon={evidenceMeta[state].icon} size={size} className={cx(state === 'superseded' && styles.muted)}>
      {t(`evidence.${state}`)}
    </StatusChip>
  );
}

export type OfferKind = 'goods' | 'works' | 'services' | 'bundle';

/** Kind badge: товар / работы / услуга / комплект. */
export function KindBadge({ kind, size }: { kind: OfferKind; size?: 'sm' | 'md' | undefined }) {
  return (
    <StatusChip tone="neutral" size={size}>
      {t(`kind.${kind}`)}
    </StatusChip>
  );
}

export type LifecycleState = 'draft' | 'inReview' | 'published' | 'active' | 'paused' | 'closed' | 'cancelled' | 'expired' | 'archived';
const lifecycleMeta: Record<LifecycleState, { tone: StatusTone; icon: LucideIcon }> = {
  draft: { tone: 'neutral', icon: FilePen },
  inReview: { tone: 'info', icon: ListChecks },
  published: { tone: 'success', icon: CircleCheck },
  active: { tone: 'success', icon: PlayCircle },
  paused: { tone: 'warning', icon: PauseCircle },
  closed: { tone: 'neutral', icon: Lock },
  cancelled: { tone: 'danger', icon: CircleX },
  expired: { tone: 'neutral', icon: Clock },
  archived: { tone: 'neutral', icon: Archive },
};

/** Generic lifecycle chip (publications, mandates, projects); object-specific vocabularies map onto it. */
export function LifecycleChip({ state, size }: { state: LifecycleState; size?: 'sm' | 'md' | undefined }) {
  return (
    <StatusChip tone={lifecycleMeta[state].tone} icon={lifecycleMeta[state].icon} size={size}>
      {t(`lifecycle.${state}`)}
    </StatusChip>
  );
}

export type RunState = 'proposed' | 'authorized' | 'reserved' | 'queued' | 'executing' | 'pending' | 'succeeded' | 'failed' | 'outcomeUnknown' | 'reconciling' | 'revoked';
const runMeta: Record<RunState, { tone: StatusTone; icon: LucideIcon }> = {
  proposed: { tone: 'neutral', icon: CircleDashed },
  authorized: { tone: 'info', icon: ShieldCheck },
  reserved: { tone: 'info', icon: Lock },
  queued: { tone: 'neutral', icon: Clock },
  executing: { tone: 'info', icon: PlayCircle },
  pending: { tone: 'warning', icon: Clock },
  succeeded: { tone: 'success', icon: CheckCircle2 },
  failed: { tone: 'danger', icon: CircleX },
  outcomeUnknown: { tone: 'warning', icon: CircleHelp },
  reconciling: { tone: 'warning', icon: RotateCw },
  revoked: { tone: 'danger', icon: CircleX },
};

/** Assistant run lifecycle incl. outcome_unknown and reconciling (R29). */
export function RunStatusBadge({ state, size }: { state: RunState; size?: 'sm' | 'md' | undefined }) {
  return (
    <StatusChip tone={runMeta[state].tone} icon={runMeta[state].icon} size={size}>
      {t(`run.state.${state}`)}
    </StatusChip>
  );
}
