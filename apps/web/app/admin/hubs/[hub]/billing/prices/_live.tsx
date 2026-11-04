import { intlTag } from '@trustwork/ui/i18n';
import { suppressSmallCount } from '@trustwork/contracts/client';
import { t, tDynamic } from '@/app/_lib/i18n';
import { submitConsoleCommand } from '../../../../_data/actions';
import type { ApprovalStage } from '../../../../_data/live-approvals';
import type { ActivationOption, FeeRow, PricesView, SaleRow, UsageRow } from '../../../../_data/live-prices';
import { ConsoleForm } from '../../../../_components/ConsoleForm';
import type { HubContext } from '../../../../_components/context';
import { formLabels, readOnlyReason, SelectField, TextInput } from '../../../../_components/forms';
import { longDate } from '../../../../_components/format';
import { ConsoleHeader, Panel } from '../../../../_components/shell';
import { Cohort, GuardRails, MarginText, moduleName, moneyMinor, StatePill } from '../../modules/_kit/parts';
import { StaffName, staffNames, type StaffNames } from '../../participants/_kit';
import { COST_BASES, COST_SUBJECTS, FEE_KINDS, FEE_PAYERS, METERS, MODEL_DIRECTIONS, PRICE_BASES, SALE_KINDS, USAGE_SUBJECTS, type PriceTarget } from './_commands';

/** Every string of the live section is under one namespace of the console locale file. */
const L = 'admin.billing.prices.live';
const meterName = (meter: string) => tDynamic(`admin.billing.prices.meters.${meter}`, meter);
const options = (values: readonly string[], label: (value: string) => string) => values.map((value) => ({ value, label: label(value) }));
const percent = (points: number) => new Intl.NumberFormat(intlTag(), { style: 'percent', maximumFractionDigits: 2 }).format(points / 10_000);
const dates = (from: string, to: string | null) => (to ? t('admin.billing.prices.live.period', { from: longDate(from), to: longDate(to) }) : t('admin.billing.prices.live.from', { from: longDate(from) }));

/** The activation of one draft: ask a second person, wait for them, or finish with the approval. */
function ActivationStep({ ctx, target, id, stage, draftedBy, supersedes = null, permission, names }: {
  ctx: HubContext; target: PriceTarget; id: string; stage: ApprovalStage; draftedBy: string; supersedes?: string | null; permission: 'admin.billing.fees.activate' | 'admin.commerce.price.activate'; names: StaffNames;
}) {
  const fields = { 'f.target': target, 'f.id': id, ...(supersedes ? { 'f.supersedes': supersedes } : {}) };
  const readOnly = readOnlyReason(ctx.can(permission), ctx.offline);
  if (stage.stage === 'approved') {
    return <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('prices.activate', fields)} labels={formLabels({ submit: t('admin.billing.prices.live.activate') })} disabledReason={readOnly} />;
  }
  if (stage.stage === 'requested') {
    return (
      <p className="admin-note">
        {t(stage.approved ? 'admin.billing.prices.live.approvedForOther' : 'admin.billing.prices.live.waiting')} <StaffName names={names} id={stage.requestedBy} /> · <a href={ctx.href('approvals')}>{t('admin.billing.prices.live.openApprovals')}</a>
      </p>
    );
  }
  // The drafter never activates and only the requester finishes, so the request has to come from someone else.
  if (draftedBy === ctx.viewer.person.id) return <p className="admin-note">{t('admin.billing.prices.live.drafterNote')}</p>;
  return (
    <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('prices.request_activation', fields)} labels={formLabels({ submit: t('admin.billing.prices.live.ask'), secondPerson: true })} disabledReason={readOnly} submitVariant="secondary" />
  );
}

function FeeAmount({ fee }: { fee: FeeRow }) {
  const { basisPoints, fixedMinor, currency } = fee.terms;
  return <>{[basisPoints === null ? null : percent(basisPoints), fixedMinor === null ? null : moneyMinor(fixedMinor, currency)].filter(Boolean).join(' + ')}</>;
}

function Fees({ ctx, fees, names }: { ctx: HubContext; fees: FeeRow[] | null; names: StaffNames }) {
  if (fees === null) return <p className="admin-empty" data-testid="fees-hidden">{t('admin.billing.prices.live.feesHidden')}</p>;
  return (
    <Panel id="fees" title={t('admin.billing.prices.live.fees')}>
      {fees.length ? (
        <ul className="admin-approvals">
          {fees.map((fee) => (
            <li key={fee.id} className="admin-approval" data-testid={`fee-${fee.terms.kind}-${fee.version}`}>
              <div className="admin-panel__head">
                <h3 className="admin-h3">
                  {tDynamic(`${L}.feeKinds.${fee.terms.kind}`, fee.terms.kind)}
                  {fee.terms.categoryKey ? <> · <code className="admin-code">{fee.terms.categoryKey}</code></> : null} · {t('admin.common.version', { version: fee.version })}
                </h3>
                <StatePill state={fee.status} />
              </div>
              <p>
                <FeeAmount fee={fee} /> · {tDynamic(`${L}.payers.${fee.terms.payer}`, fee.terms.payer)}
              </p>
              <p className="admin-meta">
                {dates(fee.terms.effectiveFrom, fee.terms.effectiveTo)} · {t('admin.billing.prices.acceptanceText')} <code className="admin-code">{fee.terms.acceptanceTextVersion}</code> · {t('admin.billing.prices.live.draftedBy')} <StaffName names={names} id={fee.draftedBy} />
              </p>
              {fee.status === 'draft' ? <ActivationStep ctx={ctx} target="fee" id={fee.id} stage={fee.stage} draftedBy={fee.draftedBy} permission="admin.billing.fees.activate" names={names} /> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="admin-empty">{t('admin.billing.prices.live.noFees')}</p>
      )}
      <p className="admin-note">{t('admin.billing.prices.readOnlyActive')}</p>
    </Panel>
  );
}

function FeeDraft({ ctx }: { ctx: HubContext }) {
  return (
    <Panel id="fee-draft" title={t('admin.billing.prices.live.feeDraft')}>
      <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('prices.fee_draft')} labels={formLabels({ submit: t('admin.billing.prices.live.feeDraft') })} disabledReason={readOnlyReason(ctx.can('admin.billing.fees.draft'), ctx.offline)}>
        <div className="admin-form__grid">
          <SelectField name="feeKind" label={t('admin.billing.prices.live.feeKind')} options={options(FEE_KINDS, (k) => tDynamic(`${L}.feeKinds.${k}`, k))} />
          <SelectField name="feePayer" label={t('admin.billing.prices.live.payer')} options={options(FEE_PAYERS, (k) => tDynamic(`${L}.payers.${k}`, k))} />
          <TextInput name="feeCategory" label={t('admin.billing.prices.live.category')} description={t('admin.billing.prices.live.categoryHelp')} />
          <TextInput name="feePercent" label={t('admin.billing.prices.live.feePercent')} description={t('admin.billing.prices.live.feePercentHelp')} />
          <TextInput name="feeFixedMinor" label={t('admin.billing.prices.live.feeFixed')} description={t('admin.billing.prices.live.feeFixedHelp', { currency: ctx.record.hub.currency })} />
          <TextInput name="feeEffectiveFrom" label={t('admin.billing.prices.effectiveFrom')} description={t('admin.product.dateHelp')} isRequired />
          <TextInput name="feeAcceptance" label={t('admin.billing.prices.live.acceptance')} description={t('admin.billing.prices.live.acceptanceHelp')} isRequired />
        </div>
      </ConsoleForm>
    </Panel>
  );
}

function SaleSubject({ sale }: { sale: SaleRow }) {
  const { terms } = sale;
  if (terms.kind === 'credit_pack') return <>{t('admin.billing.prices.live.creditPack', { credits: terms.creditMinor })}</>;
  return <>{t(terms.kind === 'model' ? 'admin.billing.prices.subjectModel' : 'admin.billing.prices.subjectCapability')} <code className="admin-code">{terms.kind === 'model' ? terms.modelId : terms.capabilityId}</code> · {t('admin.billing.prices.live.perUnits', { units: terms.perUnits, meter: meterName(terms.meter) })}</>;
}

function SaleOption({ ctx, sale, option, names }: { ctx: HubContext; sale: SaleRow; option: ActivationOption; names: StaffNames }) {
  return (
    <li>
      <p className="admin-meta">{option.supersedes ? t('admin.billing.prices.live.replaces', { id: option.supersedes.slice(0, 8) }) : t('admin.billing.prices.live.replacesNothing')}</p>
      <ActivationStep ctx={ctx} target="sale" id={sale.id} stage={option.stage} draftedBy={sale.draftedBy} supersedes={option.supersedes} permission="admin.commerce.price.activate" names={names} />
    </li>
  );
}

function Sales({ ctx, sales, names }: { ctx: HubContext; sales: SaleRow[] | null; names: StaffNames }) {
  if (sales === null) return <p className="admin-empty" data-testid="sales-hidden">{t('admin.billing.prices.live.salesHidden')}</p>;
  return (
    <Panel id="sale-prices" title={t('admin.billing.prices.live.sales')}>
      {sales.length ? (
        <ul className="admin-approvals">
          {sales.map((sale) => (
            <li key={sale.id} className="admin-approval" data-testid={`sale-${sale.terms.code}-${sale.version}`}>
              <div className="admin-panel__head">
                <h3 className="admin-h3">
                  <span lang="und">{sale.terms.name}</span> · {t('admin.common.version', { version: sale.version })}
                </h3>
                <StatePill state={sale.status} />
              </div>
              <p>
                {moneyMinor(sale.terms.amountMinor, sale.terms.currency)} · <SaleSubject sale={sale} />
              </p>
              <p className="admin-meta">
                {dates(sale.terms.effectiveFrom, sale.effectiveEnd ?? sale.terms.effectiveTo)} · {t('admin.billing.prices.acceptanceText')} <code className="admin-code">{sale.terms.acceptanceTextVersion}</code> · {t('admin.billing.prices.live.draftedBy')} <StaffName names={names} id={sale.draftedBy} />
              </p>
              {sale.status === 'draft' ? (
                <ul className="admin-list">
                  {sale.options.map((option) => (
                    <SaleOption key={option.digest} ctx={ctx} sale={sale} option={option} names={names} />
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="admin-empty">{t('admin.billing.prices.live.noSales')}</p>
      )}
      <p className="admin-note">{t('admin.billing.prices.live.salesNote')}</p>
    </Panel>
  );
}

function SaleDraft({ ctx }: { ctx: HubContext }) {
  return (
    <Panel id="sale-draft" title={t('admin.billing.prices.live.saleDraft')}>
      <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('prices.sale_draft')} labels={formLabels({ submit: t('admin.billing.prices.live.saleDraft') })} disabledReason={readOnlyReason(ctx.can('admin.commerce.price.draft'), ctx.offline)}>
        <div className="admin-form__grid">
          <SelectField name="saleKind" label={t('admin.billing.prices.live.saleKind')} options={options(SALE_KINDS, (k) => tDynamic(`${L}.subjects.${k}`, k))} />
          <TextInput name="saleSubject" label={t('admin.billing.prices.live.saleSubject')} description={t('admin.billing.prices.live.saleSubjectHelp')} isRequired />
          <TextInput name="saleCode" label={t('admin.billing.prices.live.code')} description={t('admin.billing.prices.live.codeHelp')} isRequired />
          <TextInput name="saleName" label={t('admin.billing.prices.live.name')} isRequired />
          <SelectField name="saleMeter" label={t('admin.billing.prices.live.meter')} options={options(METERS, meterName)} />
          <TextInput name="salePerUnits" label={t('admin.billing.prices.live.units')} description={t('admin.billing.prices.live.unitsHelp')} isRequired />
          <TextInput name="saleAmountMinor" label={t('admin.billing.prices.live.amountMinor')} description={t('admin.billing.prices.live.amountHelp', { currency: ctx.record.hub.currency })} isRequired />
          <TextInput name="saleEffectiveFrom" label={t('admin.billing.prices.effectiveFrom')} description={t('admin.product.dateHelp')} isRequired />
          <TextInput name="saleAcceptance" label={t('admin.billing.prices.live.acceptance')} description={t('admin.billing.prices.live.acceptanceHelp')} isRequired />
        </div>
      </ConsoleForm>
    </Panel>
  );
}

function UsageSubjectName({ row }: { row: UsageRow }) {
  const { subject } = row.terms;
  if (subject.kind === 'module') return <>{t('admin.billing.prices.subjectModule', { name: moduleName(subject.key) })}</>;
  if (subject.kind === 'meter') return <>{t('admin.billing.prices.live.subjectMeter', { name: meterName(subject.key) })}</>;
  return (
    <>
      {t(subject.kind === 'model' ? 'admin.billing.prices.subjectModel' : 'admin.billing.prices.subjectCapability')} <code className="admin-code">{subject.key}</code>
      {subject.kind === 'model' ? <> · {tDynamic(`admin.billing.prices.directions.${subject.direction}`, subject.direction)}</> : null}
    </>
  );
}

function Usage({ ctx, usage, names }: { ctx: HubContext; usage: UsageRow[] | null; names: StaffNames }) {
  if (usage === null) return <p className="admin-empty" data-testid="usage-hidden">{t('admin.billing.prices.live.usageHidden')}</p>;
  const canDraft = ctx.can('admin.commerce.price.draft');
  return (
    <Panel id="usage-prices" title={t('admin.billing.prices.versions')}>
      {usage.length ? (
        <ul className="admin-approvals">
          {usage.map((row) => (
            <li key={row.id} className="admin-approval" data-testid={`usage-${row.terms.subject.key}-${row.version}`}>
              <div className="admin-panel__head">
                <h3 className="admin-h3">
                  <UsageSubjectName row={row} /> · {t('admin.common.version', { version: row.version })}
                </h3>
                <StatePill state={row.status} />
              </div>
              <p>
                {t('admin.product.cost')} {moneyMinor(row.terms.costPerUnitMinor, row.terms.currency)} · {t('admin.product.sale')} {moneyMinor(row.terms.salePerUnitMinor, row.terms.currency)} · {t('admin.product.margin')}{' '}
                <MarginText margin={row.marginPerUnitMinor} currency={row.terms.currency} />
              </p>
              <p className="admin-meta">
                {tDynamic(`admin.product.units.${row.terms.unit}`, row.terms.unit)} · {row.terms.basis === 'markup' ? t('admin.billing.prices.markup', { percent: row.terms.markupPercent ?? 0 }) : t('admin.billing.prices.flat')} · {dates(row.terms.effectiveFrom, row.terms.effectiveTo)} ·{' '}
                {t('admin.billing.prices.acceptanceText')} <code className="admin-code">{row.terms.acceptanceTextVersion}</code> · {t('admin.billing.prices.acceptances')} <Cohort value={suppressSmallCount(row.acceptances)} /> · {t('admin.billing.prices.live.draftedBy')} <StaffName names={names} id={row.draftedBy} />
              </p>
              {row.currentCost && row.status === 'active' ? (
                <p className="admin-callout admin-callout--warning" data-testid="cost-changed">
                  {t('admin.billing.prices.costChanged', { cost: moneyMinor(row.currentCost.costPerUnitMinor, row.terms.currency), date: longDate(row.currentCost.observedAt), margin: moneyMinor(row.currentMarginPerUnitMinor ?? '0', row.terms.currency) })} <UsageSubjectName row={row} />
                </p>
              ) : null}
              {row.status === 'draft' ? (
                <>
                  <ActivationStep ctx={ctx} target="usage" id={row.id} stage={row.stage} draftedBy={row.draftedBy} permission="admin.commerce.price.activate" names={names} />
                  <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('prices.usage_cancel', { 'f.id': row.id })} labels={formLabels({ submit: t('admin.billing.prices.cancelDraft') })} disabledReason={readOnlyReason(canDraft, ctx.offline)} submitVariant="danger" />
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="admin-empty">{t('admin.billing.prices.none')}</p>
      )}
      <p className="admin-note">{t('admin.billing.prices.readOnlyActive')}</p>
    </Panel>
  );
}

function UsageForms({ ctx }: { ctx: HubContext }) {
  const canDraft = readOnlyReason(ctx.can('admin.commerce.price.draft'), ctx.offline);
  return (
    <>
      <Panel id="cost-record" title={t('admin.billing.prices.live.costRecord')}>
        <p className="admin-note">{t('admin.billing.prices.live.costHelp')}</p>
        <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('prices.cost_record')} labels={formLabels({ submit: t('admin.billing.prices.live.costRecord') })} disabledReason={canDraft}>
          <div className="admin-form__grid">
            <SelectField name="costSubject" label={t('admin.billing.prices.subject')} options={options(COST_SUBJECTS, (k) => tDynamic(`${L}.subjects.${k}`, k))} />
            <TextInput name="costKey" label={t('admin.billing.prices.live.key')} description={t('admin.billing.prices.live.keyHelp')} />
            <SelectField name="costMeter" label={t('admin.billing.prices.live.meter')} options={options(METERS, meterName)} />
            <TextInput name="costPerUnit" label={t('admin.billing.prices.live.costPerUnit')} description={t('admin.billing.prices.saleHelp')} isRequired />
            <SelectField name="costBasis" label={t('admin.billing.prices.live.costBasis')} options={options(COST_BASES, (k) => tDynamic(`${L}.costBases.${k}`, k))} />
          </div>
        </ConsoleForm>
      </Panel>
      <Panel id="usage-draft" title={t('admin.billing.prices.draft')}>
        <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('prices.usage_draft')} labels={formLabels({ submit: t('admin.billing.prices.draft') })} disabledReason={canDraft}>
          <div className="admin-form__grid">
            <SelectField name="usageSubject" label={t('admin.billing.prices.subject')} options={options(USAGE_SUBJECTS, (k) => tDynamic(`${L}.subjects.${k}`, k))} />
            <TextInput name="usageKey" label={t('admin.billing.prices.live.key')} description={t('admin.billing.prices.live.keyHelp')} />
            <SelectField name="usageMeter" label={t('admin.billing.prices.live.meter')} options={options(METERS, meterName)} />
            <SelectField name="usageDirection" label={t('admin.billing.prices.live.direction')} options={options(MODEL_DIRECTIONS, (k) => tDynamic(`admin.billing.prices.directions.${k}`, k))} description={t('admin.billing.prices.live.directionHelp')} />
            <SelectField name="usageBasis" label={t('admin.billing.prices.basis')} options={options(PRICE_BASES, (k) => t(k === 'flat' ? 'admin.billing.prices.flat' : 'admin.billing.prices.markupLabel'))} />
            <TextInput name="usageSale" label={t('admin.billing.prices.sale')} description={t('admin.billing.prices.saleHelp')} />
            <TextInput name="usagePercent" label={t('admin.billing.prices.percent')} description={t('admin.billing.prices.percentHelp')} />
            <TextInput name="usageEffectiveFrom" label={t('admin.billing.prices.effectiveFrom')} description={t('admin.product.dateHelp')} isRequired />
            <TextInput name="usageAcceptance" label={t('admin.billing.prices.live.acceptance')} description={t('admin.billing.prices.live.acceptanceHelp')} isRequired />
          </div>
          <p className="admin-note">{t('admin.billing.prices.noOverlap')}</p>
        </ConsoleForm>
      </Panel>
    </>
  );
}

/**
 * HC-91 on the API (HUBC-007): commission fees, model and capability sale versions and agent usage prices, each with its
 * activation through a second person. On a hub this deployment does not serve, nothing is shown and nothing can be sent.
 */
export async function LivePrices(ctx: HubContext) {
  const view: PricesView | null = await ctx.port.prices(ctx.record.hub.id);
  const header = <ConsoleHeader ctx={ctx} title={t('admin.billing.prices.title')} lede={t('admin.billing.prices.lede')} />;
  if (!view?.served) {
    return (
      <>
        {header}
        <p className="admin-callout admin-callout--warning" role="note" data-testid="prices-not-served">{t('admin.billing.prices.live.notServed')}</p>
      </>
    );
  }
  const stages = [...(view.fees ?? []).map((f) => f.stage), ...(view.usage ?? []).map((u) => u.stage), ...(view.sales ?? []).flatMap((s) => s.options.map((o) => o.stage))];
  const names = await staffNames(ctx, [
    ...(view.fees ?? []).map((f) => f.draftedBy), ...(view.sales ?? []).map((s) => s.draftedBy), ...(view.usage ?? []).map((u) => u.draftedBy), ...stages.flatMap((s) => (s.stage === 'requested' ? [s.requestedBy] : [])),
  ]);
  return (
    <>
      {header}
      <Fees ctx={ctx} fees={view.fees} names={names} />
      {view.fees !== null ? <FeeDraft ctx={ctx} /> : null}
      <Sales ctx={ctx} sales={view.sales} names={names} />
      {view.sales !== null ? <SaleDraft ctx={ctx} /> : null}
      <Usage ctx={ctx} usage={view.usage} names={names} />
      {view.usage !== null ? <UsageForms ctx={ctx} /> : null}
      <GuardRails only={['paymentNeutrality']} />
    </>
  );
}
