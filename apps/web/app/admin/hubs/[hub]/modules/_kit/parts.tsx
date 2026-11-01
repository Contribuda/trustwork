import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import NextLink from '@/components/locale/LocalLink';
import { type ConsoleSecondPersonAction } from '@trustwork/contracts/client';
import { intlTag } from '@trustwork/ui/i18n';
import { t, tDynamic } from '@/app/_lib/i18n';
import { submitConsoleCommand } from '../../../../_data/actions';
import type { CommandId } from '../../../../_data/commands';
import type { ChangeValue } from '../../../../_data/schemas';
import { ConsoleForm } from '../../../../_components/ConsoleForm';
import type { HubContext } from '../../../../_components/context';
import { formLabels } from '../../../../_components/forms';
import { dateTime, list } from '../../../../_components/format';
import { Panel } from '../../../../_components/shell';
import type { ActivationPreview, Cohort as CohortValue, HubProduct } from './schemas';

/** The hub's product data through the console port; a hub without it (live mode before HUBC-009) is not found. */
export async function loadProduct(ctx: HubContext): Promise<HubProduct> {
  const product = await ctx.port.product(ctx.record.hub.id);
  if (!product) notFound();
  return product;
}

/* Building blocks shared by the HUBC-005 screens (server components; strings come from `admin.product.*`). */

/** A participant count: the number, or "fewer than 10" when the cohort is suppressed. Never a smaller number. */
export function Cohort({ value }: { value: CohortValue }) {
  if (value === null) return <span data-suppressed="true">{t('admin.product.fewerThan10')}</span>;
  return <span>{new Intl.NumberFormat(intlTag()).format(value)}</span>;
}

/** An exact decimal in minor units (cents may carry fractions) as money in the viewer's language. */
export function moneyMinor(minor: string, currency: string): string {
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const negative = minor.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? minor.slice(1) : minor).split('.');
  const scaled = `${whole}${fraction}`.replace(/^0+(?=\d)/, '');
  const decimals = digits + fraction.length;
  const padded = scaled.padStart(decimals + 1, '0');
  const major = `${padded.slice(0, padded.length - decimals)}.${padded.slice(padded.length - decimals)}`;
  return new Intl.NumberFormat(intlTag(), { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: Math.min(20, decimals) }).format(Number(`${negative ? '-' : ''}${major}`));
}

/** Margin per unit beside cost and sale; a negative margin (a subsidised unit) is allowed and highlighted. */
export function MarginText({ margin, currency }: { margin: string; currency: string }) {
  const negative = margin.startsWith('-');
  return (
    <span className={negative ? 'admin-warning' : undefined} data-negative-margin={negative ? 'true' : undefined}>
      {moneyMinor(margin, currency)}
      {negative ? ` · ${t('admin.product.subsidised')}` : null}
    </span>
  );
}

export function ChangeValueText({ value }: { value: ChangeValue }) {
  if (value.kind === 'none') return <span className="admin-meta">{t('admin.common.none')}</span>;
  if (value.kind === 'text') return <span lang={value.lang}>{value.value}</span>;
  return <span>{tDynamic(`admin.${value.key}`, value.key)}</span>;
}

/** A version or record state as a pill with text (never colour alone). */
export function StatePill({ state, tone }: { state: string; tone?: 'on' | 'warn' | 'fail' | 'off' }) {
  const shade = tone ?? (state === 'active' || state === 'published' || state === 'released' || state === 'pass' || state === 'paid' ? 'on' : state === 'draft' || state === 'pending' ? 'off' : state === 'fail' || state === 'failed' ? 'fail' : 'warn');
  return <span className={`admin-pill admin-pill--${shade}`}>{tDynamic(`admin.product.states.${state}`, state)}</span>;
}

/**
 * The stored preview of a draft version (user-agents-admin.md, "Preview before activation"): the change old beside new,
 * the affected mandates, job subscriptions, connections, open runs and payers as cohort counts, participant types and
 * plans, advance notice and the estimated cost change. It is the preview the second person approves; no participant
 * is named.
 */
export function PreviewPanel({ ctx, preview, id = 'stored-preview' }: { ctx: HubContext; preview: ActivationPreview; id?: string }) {
  const zone = ctx.record.hub.timeZone;
  const affected = [
    ['mandates', preview.affected.mandates],
    ['jobSubscriptions', preview.affected.jobSubscriptions],
    ['externalConnections', preview.affected.externalConnections],
    ['openRuns', preview.affected.openRuns],
    ['payers', preview.affected.payers],
  ] as const;
  return (
    <div className="admin-subsection" data-testid="activation-preview" aria-labelledby={`${id}-title`} role="group">
      <h4 id={`${id}-title`} className="admin-h4">
        {t('admin.product.preview.title')}
      </h4>
      <p className="admin-meta">
        {t('admin.product.preview.computed', { time: dateTime(preview.computedAt, zone) })} · {t('admin.product.preview.digest')} <code className="admin-code">{preview.digest.value.slice(0, 12)}</code>
      </p>
      <ul className="admin-diff">
        {preview.changes.map((change) => (
          <li key={change.field}>
            <span className="admin-diff__field">{tDynamic(`admin.product.fields.${change.field}`, change.field)}</span>
            <span className="admin-diff__before">
              <span className="admin-visually-hidden">{t('admin.approvals.before')} </span>
              <ChangeValueText value={change.before} />
            </span>
            <span aria-hidden="true">→</span>
            <span className="admin-diff__after">
              <span className="admin-visually-hidden">{t('admin.approvals.after')} </span>
              <ChangeValueText value={change.after} />
            </span>
          </li>
        ))}
      </ul>
      <dl className="admin-dl">
        {affected.map(([key, value]) => (
          <div key={key} className="admin-dl__row">
            <dt>{t(`admin.product.preview.affected.${key}`)}</dt>
            <dd>
              <Cohort value={value} />
            </dd>
          </div>
        ))}
        <div className="admin-dl__row">
          <dt>{t('admin.product.preview.audiences')}</dt>
          <dd>{preview.audiences.length ? list(preview.audiences.map((a) => tDynamic(`admin.product.audiences.${a}`, a))) : t('admin.common.none')}</dd>
        </div>
        <div className="admin-dl__row">
          <dt>{t('admin.product.preview.plans')}</dt>
          <dd>{preview.plans.length ? list(preview.plans.map(planName)) : t('admin.product.preview.allPlans')}</dd>
        </div>
        <div className="admin-dl__row">
          <dt>{t('admin.product.preview.notice')}</dt>
          <dd>{preview.advanceNoticeDays === null ? t('admin.product.preview.noNotice') : t('admin.product.preview.noticeDays', { days: preview.advanceNoticeDays })}</dd>
        </div>
        <div className="admin-dl__row">
          <dt>{t('admin.product.preview.cost')}</dt>
          <dd>{preview.estimatedMonthlyCostChange ? t('admin.product.preview.estimate', { amount: moneyMinor(preview.estimatedMonthlyCostChange.minorUnits, preview.estimatedMonthlyCostChange.currency) }) : t('admin.product.preview.noCostChange')}</dd>
        </div>
      </dl>
      <p className="admin-note">{t('admin.product.preview.privacy')}</p>
    </div>
  );
}

export const planName = (key: string) => tDynamic(`admin.product.plans.${key}`, key);
export const moduleName = (key: string) => tDynamic(`admin.product.moduleNames.${key}`, key);
export const audienceName = (key: string) => tDynamic(`admin.product.audiences.${key}`, key);

/**
 * The only way to activate a price, plan, credit pack, commission, extension, commitment module or jurisdiction
 * setting: the stored preview, then a request that another staff member approves (HC-02). The preview's digest goes
 * with the request, so the approver binds exactly what this page showed.
 */
export function ActivationRequest({
  ctx,
  command,
  target,
  preview,
  secondPerson,
  canRequest,
  blocked,
  submit,
}: {
  ctx: HubContext;
  command: CommandId;
  target: Record<string, string>;
  preview: ActivationPreview | null;
  secondPerson: ConsoleSecondPersonAction | null;
  canRequest: boolean;
  blocked?: string | null | undefined;
  submit?: string | undefined;
}) {
  const disabledReason = ctx.offline ? t('admin.common.offlineDisabled') : !canRequest ? t('admin.common.readOnly') : (blocked ?? (!secondPerson ? t('admin.errors.activation_unavailable') : null));
  const hidden = ctx.hidden(command, { ...Object.fromEntries(Object.entries(target).map(([k, v]) => [`f.${k}`, v])), ...(preview ? { 'f.previewDigest': preview.digest.value } : {}) });
  return (
    <div className="admin-subsection" data-testid="activation-request" data-second-person={secondPerson ?? 'none'}>
      {preview ? <PreviewPanel ctx={ctx} preview={preview} id={`preview-${Object.values(target).join('-')}`} /> : null}
      <ConsoleForm
        action={submitConsoleCommand}
        hidden={hidden}
        labels={formLabels({ submit: submit ?? t('admin.product.requestActivation'), secondPerson: secondPerson !== null })}
        disabledReason={disabledReason}
      >
        {secondPerson ? <p className="admin-note">{t('admin.product.secondPersonAction', { action: tDynamic(`admin.approvals.actions.${secondPerson}`, secondPerson) })}</p> : null}
      </ConsoleForm>
    </div>
  );
}

/** Requests of these actions already waiting for a second person on HC-02. */
export async function PendingRequests({ ctx, actions }: { ctx: HubContext; actions: readonly ConsoleSecondPersonAction[] }) {
  const { requests } = await ctx.port.approvals(ctx.record.hub.id);
  const pending = requests.filter((r) => actions.includes(r.action) && r.state === 'pending');
  if (!pending.length) return null;
  return (
    <p className="admin-callout" data-testid="pending-requests">
      {t('admin.product.pendingRequests', { count: pending.length })}{' '}
      <NextLink href={ctx.href('approvals')}>{t('admin.overview.openApprovals')}</NextLink>
    </p>
  );
}

const GUARD_RAILS = ['mandates', 'confirmations', 'sanctions', 'restrictedPlaces', 'paymentNeutrality', 'noImpersonation', 'noPerPersonAgents', 'privateData'] as const;

/**
 * The guard rails no administrator can switch off (user-agents-admin.md), shown as locked: text, a "Locked" label and
 * no control. The command evaluation refuses any field that names one (`guard_rail_locked`).
 */
export function GuardRails({ only }: { only?: ReadonlyArray<(typeof GUARD_RAILS)[number]> }) {
  const rails = only ?? GUARD_RAILS;
  return (
    <Panel id="guard-rails" title={t('admin.product.guardRails.title')}>
      <p>{t('admin.product.guardRails.lede')}</p>
      <ul className="admin-list" data-testid="guard-rails">
        {rails.map((rail) => (
          <li key={rail} className="admin-list__row" data-guard-rail={rail}>
            <span>{t(`admin.product.guardRails.items.${rail}`)}</span>
            <span className="admin-pill admin-pill--fail">{t('admin.product.guardRails.locked')}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** A short explanation that a list is empty and what fills it. */
export function Empty({ children }: { children: ReactNode }) {
  return <p className="admin-empty">{children}</p>;
}

/** Hidden fields for an edit form on a versioned record: the version the page showed, for optimistic concurrency. */
export function versioned(ctx: HubContext, command: CommandId, baseVersion: number, extra: Record<string, string> = {}): Record<string, string> {
  return ctx.hidden(command, { 'f.baseVersion': String(baseVersion), ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [`f.${k}`, v])) });
}

export function yesNo(value: boolean): string {
  return t(value ? 'admin.common.yes' : 'admin.common.no');
}

export function onOff(value: boolean): string {
  return t(value ? 'admin.common.on' : 'admin.common.off');
}

/** A wide-screen hint for complex editors on phones (screens.md, "Mobile"). */
export function WideScreenNote() {
  return <p className="admin-note admin-wide-note">{t('admin.product.wideScreen')}</p>;
}

/** A labelled native select whose id is unique on the page (for repeated forms with the same field name). */
export function UniqueSelect({ id, name, label, options, description }: { id: string; name: string; label: string; options: ReadonlyArray<{ value: string; label: string }>; description?: string | undefined }) {
  const fieldId = `field-${id.replace(/[^a-zA-Z0-9]/g, '-')}`;
  return (
    <div className="admin-field">
      <label htmlFor={fieldId} className="admin-field__label">
        {label}
      </label>
      <select id={fieldId} name={`f.${name}`} className="admin-select" {...(description ? { 'aria-describedby': `${fieldId}-help` } : {})}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {description ? (
        <p id={`${fieldId}-help`} className="admin-field__help">
          {description}
        </p>
      ) : null}
    </div>
  );
}
