import type { ReactNode } from 'react';
import './commerce.css';
import NextLink from 'next/link';
import { Lock } from 'lucide-react';
import type { Party } from '@trustwork/contracts/client';
import { KindBadge, StatusChip } from '@/components/ui';
import { shortDate, t, tDynamic } from '@/app/_lib/i18n';
import { regionLabel } from '@/app/_lib/country';
import type { SharedQuoteVersion } from '@trustwork/contracts/client';
import { businessDate, money, quantity, shortDigest } from './format';

/** Server-rendered building blocks of the commerce pages (WEB-002). No data access and no client JavaScript. */

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

const RFQ_TONE: Record<string, Tone> = { draft: 'neutral', published: 'info', closed: 'neutral', cancelled: 'danger', expired: 'warning' };
const QUOTE_TONE: Record<string, Tone> = { draft: 'neutral', sent: 'info', superseded: 'neutral', withdrawn: 'warning', expired: 'warning', accepted: 'success' };
const INVITATION_TONE: Record<string, Tone> = { sent: 'info', viewed: 'info', responded: 'success', declined: 'warning', withdrawn: 'neutral' };
const AGREEMENT_TONE: Record<string, Tone> = { proposed: 'info', accepted_by_buyer: 'info', accepted_by_both: 'success', declined: 'danger', withdrawn: 'neutral', superseded: 'neutral' };
const ORDER_TONE: Record<string, Tone> = { placed: 'info', accepted: 'success', changed: 'info', cancelled: 'neutral', fulfilled: 'success' };
const NEED_TONE: Record<string, Tone> = { draft: 'neutral', clarifying: 'warning', ready: 'success', converted: 'info' };

function chip(prefix: string, tones: Record<string, Tone>, status: string) {
  return (
    <StatusChip size="sm" tone={tones[status] ?? 'neutral'}>
      {tDynamic(`commerce.status.${prefix}.${status}`, status)}
    </StatusChip>
  );
}
export const RfqStatus = ({ status }: { status: string }) => chip('rfq', RFQ_TONE, status);
export const QuoteStatus = ({ status }: { status: string }) => chip('quote', QUOTE_TONE, status);
export const InvitationStatus = ({ status }: { status: string }) => chip('invitation', INVITATION_TONE, status);
export const AgreementStatus = ({ status }: { status: string }) => chip('agreement', AGREEMENT_TONE, status);
export const OrderStatus = ({ status }: { status: string }) => chip('order', ORDER_TONE, status);
export const NeedStatus = ({ status }: { status: string }) => chip('need', NEED_TONE, status);

/** Staleness is a flag on top of the status: a version answers an earlier version of the request. */
export function StaleChip({ version }: { version: number }) {
  return (
    <StatusChip size="sm" tone="warning">
      {t('commerce.stale', { version })}
    </StatusChip>
  );
}

/** Labels data that only its owner side ever sees (never reaches the counterparty, search or notifications). */
export function PrivateLabel({ children }: { children?: ReactNode }) {
  return (
    <span className="cm-private">
      <Lock size={14} strokeWidth={2} aria-hidden="true" />
      {children ?? t('commerce.privateLabel')}
    </span>
  );
}

export function partyName(label: string | null, party: Party): string {
  return label ?? (party.kind === 'company' ? t('commerce.party.company') : t('commerce.party.person'));
}

export function Digest({ value }: { value: { value: string } | null | undefined }) {
  return (
    <code className="cm-digest" title={value?.value}>
      {shortDigest(value)}
    </code>
  );
}

export type TabDef = { id: string; label: string; count?: number | undefined };

/** Object tabs as links (`?tab=`): shareable, work without JavaScript, the current one marked `aria-current="page"`. */
export function TabNav({ tabs, current, href, label }: { tabs: TabDef[]; current: string; href: (id: string) => string; label: string }) {
  return (
    <nav className="cm-tabs" aria-label={label}>
      <ul>
        {tabs.map((tab) => (
          <li key={tab.id}>
            <NextLink href={href(tab.id)} aria-current={tab.id === current ? 'page' : undefined} className={tab.id === current ? 'cm-tab cm-tab--on' : 'cm-tab'}>
              {tab.label}
              {tab.count !== undefined ? <span className="cm-tab__count"> · {tab.count}</span> : null}
            </NextLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function Facts({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="ws-facts">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

type RfqLine = { lineId: string; kind: 'goods' | 'works' | 'services' | null; description: string; quantity: { value: string; unit: string } | null; alternativesAllowed: boolean; specification: Record<string, string> };

/** Request lines (goods, works and services may be mixed); a table on wide screens, labelled cards below 768 px. */
export function LinesTable({ lines, caption }: { lines: readonly RfqLine[]; caption: string }) {
  return (
    <div className="ws-table-wrap">
      <table className="ws-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{t('commerce.col.line')}</th>
            <th scope="col">{t('commerce.col.kind')}</th>
            <th scope="col">{t('commerce.col.quantity')}</th>
            <th scope="col">{t('commerce.col.alternatives')}</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, i) => (
            <tr key={line.lineId}>
              <td data-label={t('commerce.col.line')}>
                <strong>
                  {i + 1}. {line.description}
                </strong>
                {Object.entries(line.specification).map(([k, v]) => (
                  <span key={k} className="cm-spec">
                    {k}: {v}
                  </span>
                ))}
              </td>
              <td data-label={t('commerce.col.kind')}>{line.kind ? <KindBadge kind={line.kind} size="sm" /> : <span className="ws-note--warn">{t('commerce.need.kindMissing')}</span>}</td>
              <td data-label={t('commerce.col.quantity')}>{line.quantity ? quantity(line.quantity) : <span className="ws-note--warn">{t('commerce.need.quantityMissing')}</span>}</td>
              <td data-label={t('commerce.col.alternatives')}>{line.alternativesAllowed ? t('commerce.yes') : t('commerce.no')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A sent quote version as both sides see it (shared projection: no floors, margins or catalogue provenance). */
export function QuoteLinesTable({ version, caption }: { version: Pick<SharedQuoteVersion, 'lines' | 'totals'>; caption: string }) {
  return (
    <div className="ws-table-wrap">
      <table className="ws-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{t('commerce.col.line')}</th>
            <th scope="col">{t('commerce.col.quantity')}</th>
            <th scope="col">{t('commerce.col.unitPrice')}</th>
            <th scope="col">{t('commerce.col.tax')}</th>
            <th scope="col">{t('commerce.col.amount')}</th>
          </tr>
        </thead>
        <tbody>
          {version.lines.map((line, i) => (
            <tr key={line.lineId}>
              <td data-label={t('commerce.col.line')}>
                <strong>
                  {i + 1}. <KindBadge kind={line.kind} size="sm" />
                </strong>
                {Object.entries(line.specSnapshot).map(([k, v]) => (
                  <span key={k} className="cm-spec">
                    {k}: {v}
                  </span>
                ))}
                {line.substitution ? <span className="ws-note--warn">{t('commerce.quote.substitution', { reason: line.substitution.reason })}</span> : null}
                {line.rfqLineId === null && !line.substitution ? <span className="ws-note--warn">{t('commerce.quote.extraLine')}</span> : null}
              </td>
              <td data-label={t('commerce.col.quantity')}>{quantity(line.quantity)}</td>
              <td data-label={t('commerce.col.unitPrice')}>{money(line.unitPrice)}</td>
              <td data-label={t('commerce.col.tax')}>{line.tax.kind === 'none' ? t('commerce.tax.none') : `${line.tax.ratePercent ?? '0'}% · ${money(line.taxAmount)}`}</td>
              <td data-label={t('commerce.col.amount')}>{money(line.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="cm-totals">
        <span>
          {t('commerce.totals.net')}: <strong>{money(version.totals.net)}</strong>
        </span>
        <span>
          {t('commerce.totals.tax')}: <strong>{money(version.totals.tax)}</strong>
        </span>
        <span>
          {t('commerce.totals.gross')}: <strong>{money(version.totals.gross)}</strong>
        </span>
      </p>
    </div>
  );
}

/** Delivery and terms of one RFQ version. */
export function RfqTerms({ payload }: { payload: { deliveryTerms: { location: { region: string }; window: { from: { date: string }; to: { date: string } } }; acceptanceCriteria: string; paymentTermsRequested: string | null; currency: string; responseDeadline: string } }) {
  return (
    <Facts
      items={[
        [t('commerce.rfq.region'), regionLabel(payload.deliveryTerms.location.region) || payload.deliveryTerms.location.region],
        [t('commerce.rfq.window'), `${businessDate(payload.deliveryTerms.window.from)} – ${businessDate(payload.deliveryTerms.window.to)}`],
        [t('commerce.rfq.acceptance'), payload.acceptanceCriteria],
        [t('commerce.rfq.paymentTerms'), payload.paymentTermsRequested ?? '—'],
        [t('commerce.rfq.currency'), payload.currency],
        [t('commerce.rfq.deadline'), shortDate(payload.responseDeadline)],
      ]}
    />
  );
}

/** Obligations derived from accepted terms (deliver or perform by each milestone; pay and accept by the buyer). */
export function Obligations({ items, label }: { items: ReadonlyArray<{ party: Party; kind: string; due: string | null; amount: { minorUnits: string; currency: string } | null }>; label: (party: Party) => string }) {
  if (items.length === 0) return null;
  return (
    <ul className="ws-list" aria-label={t('commerce.order.obligations')}>
      {items.map((o, i) => (
        <li key={i} className="ws-row">
          <span className="ws-row__main">
            <span className="ws-row__title">{tDynamic(`commerce.obligation.${o.kind}`, o.kind)}</span>
            <span className="ws-row__meta">
              <span>{label(o.party)}</span>
              {o.due ? <span>{t('commerce.order.due', { date: shortDate(o.due) })}</span> : null}
              {o.amount ? <span>{money(o.amount)}</span> : null}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
