import { z } from 'zod';
import { StaffFeeSchema, StaffSalePriceSchema, type StaffFee, type StaffSalePrice } from '../../../../../packages/contracts/src/billing-fees.js';
import { MeteredPriceVersionSchema, type MeteredPriceVersion } from '../../../../../packages/contracts/src/agent-metering.js';
import { approvalStage, hubApprovals, type ApprovalStage, type LiveApproval } from './live-approvals.js';
import { costRecord, feeDraft, saleDraft, usageDraft, type PriceCommandId, type PriceForm, type PriceTarget } from '../hubs/[hub]/billing/prices/_commands.js';
import type { CommandOutcome, RejectCode } from './commands.js';

/**
 * HC-91 Prices on the API (HUBC-007): commission fees and model and capability sale versions from BILL-003, agent usage
 * prices from AGT-004. These routes act for the hub this deployment serves (`TRUSTWORK_HUB_ID`) and take no hub in their
 * path, so the console first asks which hub that is: on any other hub it shows nothing and sends nothing, because a draft
 * would land on the served hub. Every read is the viewer's own; no number here is computed that the API did not answer.
 */

const FEE_ACTION = 'billing.activate_fee_version';
const PRICE_ACTION = 'commerce.activate_price_version';
const ServingSchema = z.object({ hubId: z.uuid().nullable() });
const MeteredListSchema = z.object({ prices: z.array(MeteredPriceVersionSchema) });

export type ActivationOption = { supersedes: string | null; digest: string; stage: ApprovalStage };
export type FeeRow = StaffFee & { stage: ApprovalStage };
export type SaleRow = StaffSalePrice & { options: ActivationOption[] };
export type UsageRow = MeteredPriceVersion & { stage: ApprovalStage };
export type PricesView = {
  /** Whether this deployment serves the hub on the screen; when false every list is null. */
  served: boolean;
  /** `null`: the viewer may not read this list (never "no versions"). */
  fees: FeeRow[] | null;
  sales: SaleRow[] | null;
  usage: UsageRow[] | null;
};

export type SectionApi = { get(path: `/v1/${string}`): Promise<unknown> };
type Read = <T>(read: Promise<T>) => Promise<T | null>;
const NOT_SERVED: PricesView = { served: false, fees: null, sales: null, usage: null };

/** The prices of the hub on the screen for this viewer. Rows of any other hub are left out, whatever the API answered. */
export async function readPrices(api: SectionApi, orNothing: Read, hubId: string, viewerId: string | null, now: Date): Promise<PricesView> {
  const serving = ServingSchema.safeParse(await orNothing(api.get('/v1/pricing')));
  if (serving.data?.hubId !== hubId) return NOT_SERVED;
  const [fees, sales, usage, approvalLists] = await Promise.all([
    orNothing(api.get('/v1/admin/billing/fees')),
    orNothing(api.get('/v1/admin/billing/sale-prices')),
    orNothing(api.get('/v1/admin/billing/metered/prices')),
    orNothing(api.get(`/v1/admin/approvals?hubId=${encodeURIComponent(hubId)}`)),
  ]);
  const approvals: readonly LiveApproval[] = hubApprovals(approvalLists, hubId);
  const stageOf = (action: string, digest: string): ApprovalStage => (viewerId ? approvalStage(approvals, action, digest, viewerId, now) : { stage: 'none' });
  return {
    served: true,
    fees: fees === null ? null : StaffFeeSchema.array().parse(fees).filter((f) => f.hubId === hubId).map((f) => ({ ...f, stage: stageOf(FEE_ACTION, f.digest) })),
    sales: sales === null ? null : StaffSalePriceSchema.array().parse(sales).filter((s) => s.hubId === hubId).map((s) => ({
      ...s,
      options: [{ supersedes: null, digest: s.activationDigest }, ...s.supersedable.map((o) => ({ supersedes: o.versionId, digest: o.activationDigest }))].map((o) => ({ ...o, stage: stageOf(PRICE_ACTION, o.digest) })),
    })),
    usage: usage === null ? null : MeteredListSchema.parse(usage).prices.filter((p) => p.hubId === hubId).map((p) => ({ ...p, stage: stageOf(PRICE_ACTION, p.digest) })),
  };
}

export type SectionAnswer = { status: number; code: string | null; body?: unknown };
export type PriceSend = {
  /** A billing command: the reason, with the idempotency key in its header. These routes take no console envelope. */
  post(path: `/v1/${string}`, rest: Record<string, unknown>): Promise<SectionAnswer>;
  /** A console command with the envelope (the second-person request). */
  send(path: `/v1/${string}`, rest: Record<string, unknown>): Promise<SectionAnswer>;
  read(): Promise<PricesView>;
  form: PriceForm;
  viewerId: string;
  hubId: string;
};

const RefusalSchema = z.object({ details: z.object({ reason: z.string() }) });
const as = (code: RejectCode, field: string | null = null): CommandOutcome => ({ status: 'rejected', code, field, detail: [] });
/** Refusals with words of their own. The fee commands answer every other rule as a conflict too, so a conflict alone is not "stale". */
const REASONS: Readonly<Record<string, RejectCode>> = {
  version_overlap: 'overlap', backdated: 'back_dated', supersede_invalid: 'overlap', supersede_leaves_gap: 'overlap', cost_record_missing: 'cost_record_missing', subject_priced_elsewhere: 'priced_elsewhere',
  unavailable: 'stale', invalid_transition: 'stale', version_frozen: 'stale', revision_conflict: 'stale',
};

/** The API's refusal in the console's words; the API decided, this only names it. */
export function priceRefusal(answer: SectionAnswer): CommandOutcome {
  const reason = RefusalSchema.safeParse(answer.body).data?.details.reason.replace(/^(billing|admin)\./, '');
  if (answer.status === 404) return { status: 'not_found' };
  if (answer.status === 401) return as('elevation_required');
  if (answer.code === 'access.approval_digest_mismatch') return as('digest_mismatch');
  if (answer.code === 'access.second_approver_required') return as(reason === 'self_approval' ? 'drafter_cannot_ask' : 'second_person_pending');
  if (answer.status === 403) return as(reason === 'elevation_required' ? 'elevation_required' : 'denied');
  if (reason === 'sale_subject_unknown') return as('invalid', 'saleSubject');
  return as((reason ? REASONS[reason] : undefined) ?? 'invalid');
}

const done = (answer: SectionAnswer): CommandOutcome => (answer.status >= 200 && answer.status < 300 ? { status: 'applied' } : priceRefusal(answer));

type Target = { action: string; draftedBy: string; digest: string; stage: ApprovalStage; route: `/v1/${string}`; body: (approvalId: string) => Record<string, unknown> };

/** The draft a request or an activation names, from a fresh read: never from what the page sent. */
function targetOf(view: PricesView, kind: PriceTarget, id: string, supersedes: string | null): Target | null {
  if (kind === 'fee') {
    const row = view.fees?.find((f) => f.id === id && f.status === 'draft');
    return row ? { action: FEE_ACTION, draftedBy: row.draftedBy, digest: row.digest, stage: row.stage, route: `/v1/admin/billing/fees/${encodeURIComponent(id)}/activate`, body: (approvalId) => ({ digest: row.digest, approvalId }) } : null;
  }
  if (kind === 'usage') {
    const row = view.usage?.find((p) => p.id === id && p.status === 'draft');
    return row ? { action: PRICE_ACTION, draftedBy: row.draftedBy, digest: row.digest, stage: row.stage, route: `/v1/admin/billing/metered/prices/${encodeURIComponent(id)}/activate`, body: (approvalId) => ({ digest: row.digest, approvalId }) } : null;
  }
  const row = view.sales?.find((s) => s.id === id && s.status === 'draft');
  const option = row?.options.find((o) => o.supersedes === supersedes);
  if (!row || !option) return null;
  // The approval binds the activation digest (with `supersedes`); the command restates the version's own digest.
  return { action: PRICE_ACTION, draftedBy: row.draftedBy, digest: option.digest, stage: option.stage, route: `/v1/admin/billing/sale-prices/${encodeURIComponent(id)}/activate`, body: (approvalId) => ({ digest: row.digest, approvalId, supersedes }) };
}

/** One price command against the API. The form was checked by the shell's evaluation; the API repeats every rule. */
export async function priceCommand(command: PriceCommandId, f: Readonly<Record<string, string>>, io: PriceSend): Promise<CommandOutcome> {
  const invalid = (body: object): CommandOutcome | null => {
    if (!('field' in body)) return null;
    const refused = body as { field: string; code?: 'back_dated' };
    return as(refused.code ?? 'invalid', refused.field);
  };
  // Nothing goes out for a hub this deployment does not serve: the route would act on the served hub.
  const view = await io.read();
  if (!view.served) return { status: 'not_found' };
  switch (command) {
    case 'prices.fee_draft': {
      const body = feeDraft(f, io.form);
      return invalid(body) ?? done(await io.post('/v1/admin/billing/fees', body));
    }
    case 'prices.sale_draft': {
      const body = saleDraft(f, io.form);
      return invalid(body) ?? done(await io.post('/v1/admin/billing/sale-prices', body));
    }
    case 'prices.usage_draft': {
      const body = usageDraft(f, io.form);
      return invalid(body) ?? done(await io.post('/v1/admin/billing/metered/prices', body));
    }
    case 'prices.cost_record': {
      const body = costRecord(f, io.form);
      return invalid(body) ?? done(await io.post('/v1/admin/billing/metered/costs', body));
    }
    case 'prices.usage_cancel':
      return done(await io.post(`/v1/admin/billing/metered/prices/${encodeURIComponent(f.id ?? '')}/cancel`, {}));
    case 'prices.request_activation':
    case 'prices.activate': {
      const target = targetOf(view, f.target as PriceTarget, f.id ?? '', f.supersedes || null);
      if (!target) return { status: 'not_found' };
      if (command === 'prices.activate') {
        if (target.stage.stage !== 'approved') return as('second_person_pending');
        return done(await io.post(target.route, target.body(target.stage.requestId)));
      }
      // The drafter never activates and only the requester executes, so a drafter's request could never be finished.
      if (target.draftedBy === io.viewerId) return as('drafter_cannot_ask');
      if (target.stage.stage !== 'none') return as('second_person_pending');
      const answer = await io.send('/v1/admin/approvals', { subject: { action: target.action, scope: { kind: 'hub', hubId: io.hubId }, actionDigest: target.digest } });
      return answer.status >= 200 && answer.status < 300 ? { status: 'pending_second_person', secondPerson: target.action as 'commerce.activate_price_version' | 'billing.activate_fee_version' } : priceRefusal(answer);
    }
  }
}
