import { Briefcase, Handshake, MessageSquareText, PauseCircle, Radar, Search, ShoppingCart, UserPlus, Wrench } from 'lucide-react';
import type { CompanySignalKind, PersonSignalKind, Signal } from '@/app/_lib/data/types';
import { shortDate, t } from '@/app/_lib/i18n';

type Scope = 'person' | 'company';
type Kind = PersonSignalKind | CompanySignalKind;

const ICON: Record<Kind, typeof Briefcase> = {
  openToWork: Briefcase,
  openToProjects: Radar,
  hiring: UserPlus,
  lookingForPartners: Handshake,
  consulting: MessageSquareText,
  busy: PauseCircle,
  acceptingOrders: Radar,
  lookingForSubcontractors: Wrench,
  lookingForSuppliers: ShoppingCart,
  lookingForProjects: Search,
  paused: PauseCircle,
};
const TONE: Record<Kind, 'green' | 'blue' | 'amber' | 'grey'> = {
  openToWork: 'green',
  openToProjects: 'green',
  acceptingOrders: 'green',
  hiring: 'blue',
  consulting: 'blue',
  lookingForPartners: 'amber',
  lookingForSubcontractors: 'amber',
  lookingForSuppliers: 'amber',
  lookingForProjects: 'amber',
  busy: 'grey',
  paused: 'grey',
};

export function signalLabel(scope: Scope, kind: Kind): string {
  return t(`signals.${scope}.${kind}` as 'signals.person.openToWork');
}

/** Self-declared status pill (LinkedIn-style «open to…»): icon, label, optional note and «until» date in the title. */
export function SignalBadge({ scope, signal, size = 'md', withNote = false }: { scope: Scope; signal: Signal<Kind>; size?: 'sm' | 'md'; withNote?: boolean }) {
  const Icon = ICON[signal.kind];
  const label = signalLabel(scope, signal.kind);
  const until = signal.until ? ` · ${t('signals.until', { date: shortDate(signal.until) })}` : '';
  const title = [label + until, signal.note, t('signals.declared')].filter(Boolean).join('. ');
  return (
    <span className={`sig sig--${TONE[signal.kind]} sig--${size}`} title={title}>
      <Icon size={size === 'sm' ? 12 : 14} strokeWidth={2.2} aria-hidden="true" />
      <span>
        {label}
        {until}
      </span>
      {withNote && signal.note ? <span className="sig__note">{signal.note}</span> : null}
    </span>
  );
}
