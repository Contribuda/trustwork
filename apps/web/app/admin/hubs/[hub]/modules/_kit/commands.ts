import {
  COMMITMENT_MANDATE_KINDS,
  disclosureLocalesMissing,
  type ConsolePermission,
  type ConsoleSecondPersonAction,
  type RestrictedPredicate,
} from '@trustwork/contracts/client';
import type { HubRecord } from '../../../../_data/schemas.js';
import { AUDIENCES, PROJECT_PUBLIC_FIELDS, type HubProduct } from './schemas.js';

/**
 * Console commands of the agent product, the product modules, billing and communications (HUBC-005). The shell's
 * `evaluateCommand` (`_data/commands.ts`) runs the common checks first (role on the hub, this command's permission,
 * elevated session, offline, reason) and then calls `evaluateProductCommand`, which checks what is specific here:
 *
 * - guard rails: no field may name mandates, confirmations, sanctions, restricted places, payment neutrality or any
 *   ranking control (`guard_rail_locked`), and no field may point at one participant, their agent, mandate, goal, job
 *   subscription or connection (`per_person_forbidden`): staff configure the product for everyone;
 * - second person: activating a price, a plan, a credit pack, a commission, an extension, a commitment module or
 *   jurisdiction settings, and releasing a payout batch, only ever creates a second-person request bound to the stored
 *   preview's digest (`digest_mismatch` when the page showed another preview);
 * - optimistic concurrency per configuration version (`f.baseVersion`, `stale`), no back-dating, no overlap, limits
 *   within the hub maximum, a passing safety suite before an extension is activated, restricted places refused.
 *
 * Pure like the shell's evaluation: the fixture adapter stops at the answer ("Demo: changes are not saved"); HUBC-009
 * sends the same command to the API, which repeats every check as the authority.
 */

export const PRODUCT_COMMANDS = [
  // Product modules (HC-60 to HC-67)
  'projects.policy.save', 'projects.hold', 'planner.draft', 'planner.submit', 'planner.publish', 'planner.retire', 'marketplace.rule.save',
  'marketplace.fee.draft', 'marketplace.fee.request_activation', 'knowledge.decide', 'events.policy.save', 'events.review', 'learning.review',
  'learning.revoke_certificate', 'learning.record_accreditation', 'matching.quota.save', 'matching.method.release', 'commerce.rule.save', 'commerce.reconcile',
  // Agent product (HC-80 to HC-85)
  'agents.module.draft', 'agents.module.request_activation', 'agents.kill', 'agents.policy.draft', 'agents.policy.request_activation', 'jurisdiction.draft',
  'jurisdiction.request_activation', 'extensions.draft', 'extensions.run_safety', 'extensions.request_activation', 'extensions.suspend', 'extensions.retire',
  'external.save', 'usage.export', 'abuse.thresholds.draft', 'abuse.open_case',
  // Billing (HC-90 to HC-95)
  'billing.plan.draft', 'billing.plan.request_activation', 'billing.price.draft', 'billing.price.request_activation', 'billing.price.cancel_draft',
  'billing.invoice.retry', 'billing.payout.request_release', 'billing.payout.reconcile', 'billing.credit.issue', 'billing.refund_policy.save',
  'billing.pack.draft', 'billing.pack.request_activation', 'billing.tax.save',
  // Communications (HC-120 to HC-123)
  'comms.domain.add', 'comms.domain.recheck', 'comms.template.save', 'comms.template.activate', 'comms.template.pause', 'comms.announcement.draft',
  'comms.announcement.send',
] as const;
export type ProductCommandId = (typeof PRODUCT_COMMANDS)[number];
export function isProductCommand(value: unknown): value is ProductCommandId {
  return typeof value === 'string' && (PRODUCT_COMMANDS as readonly string[]).includes(value);
}

/** The permission each command needs on the hub (any one of the list). */
export const PRODUCT_COMMAND_PERMISSIONS: Record<ProductCommandId, readonly ConsolePermission[]> = {
  'projects.policy.save': ['admin.hub.modes.edit'],
  'projects.hold': ['admin.publications.hold'],
  'planner.draft': ['admin.planner.templates.edit'],
  'planner.submit': ['admin.planner.templates.edit'],
  'planner.publish': ['admin.planner.templates.publish'],
  'planner.retire': ['admin.planner.templates.publish'],
  'marketplace.rule.save': ['admin.marketplace.rules.edit'],
  'marketplace.fee.draft': ['admin.billing.fees.draft'],
  'marketplace.fee.request_activation': ['admin.billing.fees.draft'],
  'knowledge.decide': ['admin.knowledge.shares.review'],
  'events.policy.save': ['admin.events.policy.edit'],
  'events.review': ['admin.events.review'],
  'learning.review': ['admin.learning.review'],
  'learning.revoke_certificate': ['admin.learning.certificate.revoke'],
  'learning.record_accreditation': ['admin.learning.accreditation.record'],
  'matching.quota.save': ['admin.matching.policy.edit'],
  'matching.method.release': ['admin.matching.method.release'],
  'commerce.rule.save': ['admin.commerce.category_rules.edit'],
  'commerce.reconcile': ['admin.assistant.reconcile'],
  'agents.module.draft': ['admin.agents.modules.edit'],
  'agents.module.request_activation': ['admin.agents.modules.edit'],
  'agents.kill': ['admin.agents.kill'],
  'agents.policy.draft': ['admin.agents.policy.edit'],
  'agents.policy.request_activation': ['admin.agents.policy.edit'],
  'jurisdiction.draft': ['admin.hub.jurisdiction.edit'],
  'jurisdiction.request_activation': ['admin.hub.jurisdiction.edit'],
  'extensions.draft': ['admin.agents.extensions.edit'],
  'extensions.run_safety': ['admin.agents.extensions.edit'],
  'extensions.request_activation': ['admin.agents.extensions.edit'],
  'extensions.suspend': ['admin.agents.extensions.suspend'],
  'extensions.retire': ['admin.agents.extensions.edit'],
  'external.save': ['admin.agents.policy.edit', 'admin.agents.clients.manage'],
  'usage.export': ['admin.agents.read'],
  'abuse.thresholds.draft': ['admin.agents.policy.edit'],
  'abuse.open_case': ['admin.moderation.case.open'],
  'billing.plan.draft': ['admin.commerce.offer.edit'],
  'billing.plan.request_activation': ['admin.commerce.offer.edit'],
  'billing.price.draft': ['admin.commerce.price.draft'],
  'billing.price.request_activation': ['admin.commerce.price.draft'],
  'billing.price.cancel_draft': ['admin.commerce.price.draft'],
  'billing.invoice.retry': ['admin.commerce.offer.edit'],
  'billing.payout.request_release': ['admin.billing.payouts.release'],
  'billing.payout.reconcile': ['admin.assistant.reconcile'],
  'billing.credit.issue': ['admin.commerce.credit.issue'],
  'billing.refund_policy.save': ['admin.commerce.refund.policy'],
  'billing.pack.draft': ['admin.commerce.offer.edit'],
  'billing.pack.request_activation': ['admin.commerce.offer.edit'],
  'billing.tax.save': ['admin.commerce.offer.edit'],
  'comms.domain.add': ['admin.providers.connection.edit'],
  'comms.domain.recheck': ['admin.providers.connection.edit'],
  'comms.template.save': ['admin.notifications.template.edit'],
  'comms.template.activate': ['admin.notifications.template.edit'],
  'comms.template.pause': ['admin.notifications.template.edit'],
  'comms.announcement.draft': ['admin.notifications.broadcast'],
  'comms.announcement.send': ['admin.notifications.broadcast'],
};

export const PRODUCT_REJECT_CODES = [
  'guard_rail_locked', 'per_person_forbidden', 'author_cannot_publish', 'template_blocked', 'consent_missing', 'safety_suite_failed', 'commitment_requires_verified',
  'above_maximum', 'above_cap', 'back_dated', 'overlap', 'weaker_than_pack', 'lawful_basis_missing', 'source_required', 'licence_requires_verified', 'not_draft',
] as const;
export type ProductRejectCode = (typeof PRODUCT_REJECT_CODES)[number];

/**
 * Field names no product command accepts. The first group are the guard rails no administrator can switch off
 * (user-agents-admin.md, "Guard rails no administrator can switch off") and the controls staff never have (scores,
 * ranks, boosts, badges); the second group would point at one participant's agent product.
 */
const GUARD_RAIL_FIELD = /(mandate|confirm|sanction|screening|restricted|neutral|rank|boost|featured|badge|score|weight|impersonat|egress)/i;
const PER_PERSON_FIELD = /(person|participant|agent|principal|goal|subscription|connection)(_?id)?$/i;

type Outcome =
  | { status: 'demo_not_saved'; secondPerson: ConsoleSecondPersonAction | null }
  | { status: 'rejected'; code: ProductRejectCode | 'invalid' | 'stale' | 'digest_mismatch' | 'territory_restricted' | 'language_missing'; field: string | null; detail: string[] }
  | { status: 'not_found' };

export type ProductCommandContext = { viewerId: string; hub: HubRecord; product: HubProduct | null; now: Date; isRestricted: RestrictedPredicate };

const reject = (code: Extract<Outcome, { status: 'rejected' }>['code'], field: string | null = null, detail: string[] = []): Outcome => ({ status: 'rejected', code, field, detail });
const ok = (secondPerson: ConsoleSecondPersonAction | null = null): Outcome => ({ status: 'demo_not_saved', secondPerson });
const NOT_FOUND: Outcome = { status: 'not_found' };

const KEY = /^[a-z][a-z0-9_]{1,60}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const DECIMAL = /^(0|[1-9]\d{0,9})(\.\d{1,6})?$/;
const int = (value: string | undefined, min: number, max: number): number | null => {
  if (value === undefined || !/^\d{1,9}$/.test(value.trim())) return null;
  const n = Number.parseInt(value, 10);
  return n >= min && n <= max ? n : null;
};
const httpsUrl = (value: string | undefined) => {
  try {
    return new URL((value ?? '').trim()).protocol === 'https:';
  } catch {
    return false;
  }
};
/** A calendar date typed by staff (`YYYY-MM-DD`), as the start of that day in UTC. */
const dateStart = (value: string | undefined): number | null => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? Date.parse(`${value}T00:00:00Z`) : null);
const oneOf = <T extends string>(value: string | undefined, options: readonly T[]): value is T => value !== undefined && (options as readonly string[]).includes(value);
const sameDigest = (fields: Readonly<Record<string, string>>, value: string) => fields.previewDigest === value;
const stale = (fields: Readonly<Record<string, string>>, current: number) => int(fields.baseVersion, 0, 1_000_000) !== current;

/** Evaluates one HUBC-005 command after the shell's common checks. Pure: no clock beyond `ctx.now`, no I/O. */
export function evaluateProductCommand(command: ProductCommandId, f: Readonly<Record<string, string>>, ctx: ProductCommandContext): Outcome {
  const product = ctx.product;
  if (!product || product.hubId !== ctx.hub.hub.id) return NOT_FOUND;
  const names = Object.keys(f);
  const locked = names.filter((n) => GUARD_RAIL_FIELD.test(n) && n !== 'previewDigest');
  if (locked.length) return reject('guard_rail_locked', locked[0]!, locked);
  const personal = names.filter((n) => PER_PERSON_FIELD.test(n));
  if (personal.length) return reject('per_person_forbidden', personal[0]!, personal);
  const now = ctx.now.getTime();
  const { agents, modules, billing, communications } = product;

  switch (command) {
    /* ---------- Product modules ---------- */
    case 'projects.policy.save': {
      if (stale(f, modules.projects.version)) return reject('stale');
      if (f.publishingAllowed !== undefined && f.publishingAllowed !== 'on' && f.publishingAllowed !== 'off') return reject('invalid', 'publishingAllowed');
      // Narrower only: a field outside the engine allowlist (budgets, private files, the owner's contacts) is refused.
      if (f.field !== undefined && !oneOf(f.field, PROJECT_PUBLIC_FIELDS)) return reject('guard_rail_locked', 'field', [f.field]);
      if (f.field !== undefined && f.include !== 'true' && f.include !== 'false') return reject('invalid', 'include');
      return ok();
    }
    case 'projects.hold':
      return modules.projects.reports.some((r) => r.id === f.reportId) ? ok() : NOT_FOUND;
    case 'planner.draft':
      if (!KEY.test(f.templateKey ?? '')) return reject('invalid', 'templateKey');
      if (!KEY.test(f.projectType ?? '')) return reject('invalid', 'projectType');
      return ok();
    case 'planner.submit':
    case 'planner.publish':
    case 'planner.retire': {
      const found = modules.planner.templates.find((t) => t.template.id === f.templateId);
      if (!found) return NOT_FOUND;
      const t = found.template;
      if (command === 'planner.retire') return t.status === 'published' ? ok() : reject('invalid', 'templateId');
      if (command === 'planner.submit') return t.status === 'draft' ? ok() : reject('invalid', 'templateId');
      if (t.status !== 'in_review') return reject('invalid', 'templateId');
      const blocked = modules.planner.blocked.filter((b) => b.templateKey === t.key && b.version === t.version);
      if (blocked.length) return reject('template_blocked', 'templateId', blocked.map((b) => b.itemKey));
      if (t.authors.includes(ctx.viewerId)) return reject('author_cannot_publish', 'templateId');
      return ok();
    }
    case 'marketplace.rule.save': {
      const rule = modules.marketplace.rules.find((r) => r.categoryKey === f.categoryKey);
      if (!rule) return NOT_FOUND;
      if (stale(f, rule.version)) return reject('stale');
      const who = f.whoMayOffer ?? rule.whoMayOffer;
      if (!oneOf(who, ['verified_company', 'verified_professional', 'verified_company_or_professional', 'claimed_company_or_professional'] as const)) return reject('invalid', 'whoMayOffer');
      if (rule.licenceCategory !== null && who === 'claimed_company_or_professional') return reject('licence_requires_verified', 'whoMayOffer');
      if (f.mayAcceptWithinMandate === 'on' && who === 'claimed_company_or_professional') return reject('licence_requires_verified', 'mayAcceptWithinMandate');
      if (f.requestsPerWeek !== undefined && int(f.requestsPerWeek, 0, 500) === null) return reject('invalid', 'requestsPerWeek');
      return ok();
    }
    case 'marketplace.fee.draft': {
      if (!oneOf(f.kind, ['consultation', 'task', 'ticket', 'course'] as const)) return reject('invalid', 'kind');
      if (int(f.basisPoints, 0, 10_000) === null) return reject('invalid', 'basisPoints');
      const start = dateStart(f.effectiveFrom);
      if (start === null) return reject('invalid', 'effectiveFrom');
      if (start <= now) return reject('back_dated', 'effectiveFrom');
      const active = modules.marketplace.fees.find((x) => x.fee.status === 'active' && x.fee.kind === f.kind && x.fee.categoryKey === (f.categoryKey || null));
      if (active && start <= Date.parse(active.fee.effectiveFrom)) return reject('overlap', 'effectiveFrom');
      return ok();
    }
    case 'marketplace.fee.request_activation': {
      const found = modules.marketplace.fees.find((x) => x.fee.id === f.feeId);
      if (!found) return NOT_FOUND;
      if (found.fee.status !== 'draft' || !found.preview) return reject('not_draft', 'feeId');
      if (Date.parse(found.fee.effectiveFrom) <= now) return reject('back_dated', 'feeId');
      if (!sameDigest(f, found.preview.digest.value)) return reject('digest_mismatch');
      return ok('billing.activate_fee_version');
    }
    case 'knowledge.decide': {
      const found = modules.knowledge.shares.find((s) => s.share.id === f.shareId);
      if (!found) return NOT_FOUND;
      if (!oneOf(f.decision, ['publish', 'return', 'withdraw'] as const)) return reject('invalid', 'decision');
      if (f.decision === 'publish') {
        const missing = found.parties.filter((p) => p.consent !== 'given');
        if (missing.length) return reject('consent_missing', 'shareId', missing.map((p) => p.label.text));
      }
      return ok();
    }
    case 'events.policy.save':
      if (f.hostingPolicy !== undefined && !oneOf(f.hostingPolicy, ['editorial_only', 'verified_and_editorial', 'anyone_reviewed', 'anyone_unreviewed'] as const)) return reject('invalid', 'hostingPolicy');
      return ok();
    case 'events.review':
      if (!modules.events.inReview.some((e) => e.id === f.eventId)) return NOT_FOUND;
      return oneOf(f.decision, ['approve', 'return'] as const) ? ok() : reject('invalid', 'decision');
    case 'learning.review':
      if (!modules.learning.inReview.some((e) => e.id === f.courseId)) return NOT_FOUND;
      return oneOf(f.decision, ['approve', 'return'] as const) ? ok() : reject('invalid', 'decision');
    case 'learning.revoke_certificate':
      if (!REF.test(f.certificateRef ?? '')) return reject('invalid', 'certificateRef');
      return oneOf(f.reasonCategory, ['issued_in_error', 'fraud', 'course_withdrawn'] as const) ? ok() : reject('invalid', 'reasonCategory');
    case 'learning.record_accreditation':
      if (!(f.body ?? '').trim()) return reject('invalid', 'body');
      return httpsUrl(f.source) ? ok() : reject('source_required', 'source');
    case 'matching.quota.save':
      return int(f.introductionsPerPersonPerWeek, 0, 100) === null ? reject('invalid', 'introductionsPerPersonPerWeek') : ok();
    case 'matching.method.release': {
      const draft = modules.matching.methods.find((m) => m.version === int(f.version, 1, 1000));
      if (!draft) return NOT_FOUND;
      return draft.status === 'draft' ? ok() : reject('not_draft', 'version');
    }
    case 'commerce.rule.save': {
      if (!KEY.test(f.categoryKey ?? '')) return reject('invalid', 'categoryKey');
      const rule = modules.commerce.rules.find((r) => r.categoryKey === f.categoryKey);
      if (rule && stale(f, rule.version)) return reject('stale');
      return ok();
    }
    case 'commerce.reconcile':
      if (!modules.commerce.unknownOutcomes.some((u) => u.id === f.outcomeId)) return NOT_FOUND;
      return REF.test((f.evidence ?? '').trim()) ? ok() : reject('invalid', 'evidence');

    /* ---------- Agent product ---------- */
    case 'agents.module.draft': {
      const module = agents.modules.find((m) => m.key === f.moduleKey);
      if (!module) return NOT_FOUND;
      if (stale(f, module.version)) return reject('stale');
      if (f.capability !== undefined) {
        if (!module.capabilities.some((cap) => cap.id === f.capability)) return reject('invalid', 'capability');
        const scope = f.scope ?? '';
        const [kind, value] = scope.split(':');
        const valid = scope === 'hub' || (kind === 'audience' && oneOf(value, AUDIENCES)) || (kind === 'plan' && agents.plans.includes(value ?? ''));
        if (!valid) return reject('invalid', 'scope');
        if (f.state !== 'on' && f.state !== 'off') return reject('invalid', 'state');
      }
      if (f.defaultKey !== undefined) {
        const setting = module.defaults.find((d) => d.key === f.defaultKey);
        if (!setting) return reject('invalid', 'defaultKey');
        const maximum = f.maximum === undefined || f.maximum === '' ? setting.maximum : int(f.maximum, 0, 100_000);
        const value = int(f.value, 0, 100_000);
        if (maximum === null) return reject('invalid', 'maximum');
        if (value === null) return reject('invalid', 'value');
        if (value > maximum) return reject('above_maximum', 'value', [String(maximum)]);
      }
      return ok();
    }
    case 'agents.module.request_activation': {
      const module = agents.modules.find((m) => m.key === f.moduleKey);
      if (!module) return NOT_FOUND;
      if (!module.draft) return reject('not_draft', 'moduleKey');
      const commits = module.actions.some((a) => (COMMITMENT_MANDATE_KINDS as readonly string[]).includes(a));
      if (commits && !module.verifiedCompanyRequired) return reject('commitment_requires_verified', 'moduleKey');
      if (!sameDigest(f, module.draft.preview.digest.value)) return reject('digest_mismatch');
      return ok(commits ? 'agents.enable_commitment_module' : null);
    }
    case 'agents.kill': {
      if (f.scope === 'agent_module') return agents.modules.some((m) => m.key === f.target) ? ok() : NOT_FOUND;
      if (f.scope === 'agent_extension') return agents.extensions.some((e) => e.ref.extensionId === f.target) ? ok() : NOT_FOUND;
      if (f.scope === 'agent_action') return oneOf(f.target, ['prepare', 'research', 'communicate', 'send_quote', 'negotiate', 'place_order', 'accept_order', 'generate_deliverable'] as const) ? ok() : reject('invalid', 'target');
      return reject('invalid', 'scope');
    }
    case 'agents.policy.draft': {
      if (stale(f, agents.policy.version)) return reject('stale');
      if (f.outreachPerPersonPerWeek !== undefined && int(f.outreachPerPersonPerWeek, 0, 500) === null) return reject('invalid', 'outreachPerPersonPerWeek');
      if (f.requestsPerWeek !== undefined && int(f.requestsPerWeek, 0, 500) === null) return reject('invalid', 'requestsPerWeek');
      if (f.disclosureLang !== undefined && !ctx.hub.hub.locales.includes(f.disclosureLang)) return reject('invalid', 'disclosureLang');
      if (f.disclosureLang !== undefined && !(f.disclosureText ?? '').trim()) return reject('invalid', 'disclosureText');
      return ok();
    }
    case 'agents.policy.request_activation': {
      const draft = agents.policy.draft;
      if (!draft) return reject('not_draft');
      if (!sameDigest(f, draft.preview.digest.value)) return reject('digest_mismatch');
      const missing = ctx.hub.hub.locales.filter((l) => !agents.policy.disclosure.some((d) => d.lang === l));
      if (missing.length) return reject('language_missing', null, missing);
      return ok();
    }
    case 'jurisdiction.draft': {
      const code = (f.jurisdiction ?? '').trim().toUpperCase();
      if (!/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(code)) return reject('invalid', 'jurisdiction');
      if (ctx.isRestricted(code) || ctx.isRestricted(code.slice(0, 2))) return reject('territory_restricted', 'jurisdiction');
      if (!oneOf(f.area, ['agent_disclosure', 'liability_allocation', 'consent', 'record_keeping', 'action_limits', 'legal_texts'] as const)) return reject('invalid', 'area');
      if (f.comparison === 'weaker') return reject('weaker_than_pack', 'comparison');
      if (!oneOf(f.comparison, ['same', 'stricter'] as const)) return reject('invalid', 'comparison');
      if (!(f.value ?? '').trim()) return reject('invalid', 'value');
      return ok();
    }
    case 'jurisdiction.request_activation': {
      const found = agents.policy.jurisdictions.find((j) => j.ref.configVersionId === f.configVersionId);
      if (!found) return NOT_FOUND;
      if (found.ref.status !== 'draft') return reject('not_draft', 'configVersionId');
      const missing = disclosureLocalesMissing(found.ref, ctx.hub.hub);
      if (missing.length) return reject('language_missing', 'configVersionId', missing);
      return ok('jurisdiction.activate_settings');
    }
    case 'extensions.draft': {
      if (!KEY.test(f.key ?? '')) return reject('invalid', 'key');
      const host = (f.endpointHost ?? '').trim().toLowerCase();
      const country = (f.endpointCountry ?? '').trim().toUpperCase();
      if (host && !HOST.test(host)) return reject('invalid', 'endpointHost');
      if (host && !/^[A-Z]{2}$/.test(country)) return reject('invalid', 'endpointCountry');
      if (country && ctx.isRestricted(country)) return reject('territory_restricted', 'endpointCountry');
      if (!oneOf(f.actionKind, ['prepare', 'research', 'communicate', 'send_quote', 'negotiate', 'maintain_records', 'schedule', 'publish'] as const)) return reject('invalid', 'actionKind');
      return ok();
    }
    case 'extensions.run_safety':
      return agents.extensions.some((e) => e.ref.id === f.extensionVersionId && e.ref.status !== 'retired') ? ok() : NOT_FOUND;
    case 'extensions.request_activation': {
      const ext = agents.extensions.find((e) => e.ref.id === f.extensionVersionId);
      if (!ext) return NOT_FOUND;
      if (ext.ref.safetySuite?.passed !== true || !ext.ref.safetySuite.onFakeAdapter) return reject('safety_suite_failed', 'extensionVersionId');
      if (ext.ref.status !== 'tested' || !ext.preview) return reject('not_draft', 'extensionVersionId');
      if (ext.ref.endpoints.some((e) => ctx.isRestricted(e.country))) return reject('territory_restricted', 'extensionVersionId');
      if (!sameDigest(f, ext.preview.digest.value)) return reject('digest_mismatch');
      return ok('agents.activate_extension');
    }
    case 'extensions.suspend': {
      const ext = agents.extensions.find((e) => e.ref.id === f.extensionVersionId);
      if (!ext) return NOT_FOUND;
      return ext.ref.status === 'active' ? ok() : reject('invalid', 'extensionVersionId');
    }
    case 'extensions.retire': {
      const ext = agents.extensions.find((e) => e.ref.id === f.extensionVersionId);
      if (!ext) return NOT_FOUND;
      return ext.ref.status === 'retired' ? reject('invalid', 'extensionVersionId') : ok();
    }
    case 'external.save': {
      const def = int(f.defaultPerMinute, 1, 600);
      const max = int(f.maximumPerMinute, 1, 600);
      if (def === null) return reject('invalid', 'defaultPerMinute');
      if (max === null) return reject('invalid', 'maximumPerMinute');
      if (def > max) return reject('above_maximum', 'defaultPerMinute', [String(max)]);
      if (f.accessTokenTtlSeconds !== undefined && int(f.accessTokenTtlSeconds, 60, 900) === null) return reject('invalid', 'accessTokenTtlSeconds');
      return ok();
    }
    case 'usage.export':
      return oneOf(f.period, ['month', 'quarter'] as const) ? ok() : reject('invalid', 'period');
    case 'abuse.thresholds.draft':
      if (!agents.abuse.signals.some((s) => s.kind === f.signal)) return reject('invalid', 'signal');
      return int(f.threshold, 1, 100_000) === null ? reject('invalid', 'threshold') : ok();
    case 'abuse.open_case':
      return agents.abuse.signals.some((s) => s.kind === f.signal) ? ok() : reject('invalid', 'signal');

    /* ---------- Billing ---------- */
    case 'billing.plan.draft':
      if (!billing.offers.some((o) => o.id === f.offerId && o.kind === 'plan')) return NOT_FOUND;
      return int(f.trialDays, 0, 90) === null ? reject('invalid', 'trialDays') : ok();
    case 'billing.plan.request_activation': {
      const plan = billing.plans.find((p) => p.plan.id === f.planId);
      if (!plan) return NOT_FOUND;
      if (plan.plan.status !== 'draft' || !plan.preview) return reject('not_draft', 'planId');
      if (Date.parse(plan.price.effectiveFrom) <= now) return reject('back_dated', 'planId');
      if (!sameDigest(f, plan.preview.digest.value)) return reject('digest_mismatch');
      return ok('commerce.activate_price_version');
    }
    case 'billing.price.draft': {
      const subject = f.subject ?? '';
      const existing = billing.prices.filter((p) => `${p.subject.kind}:${p.subject.key}${p.subject.kind === 'model' ? `:${p.subject.direction}` : ''}` === subject);
      if (!existing.length) return reject('invalid', 'subject');
      if (f.basis === 'flat') {
        if (!DECIMAL.test(f.sale ?? '')) return reject('invalid', 'sale');
      } else if (f.basis === 'markup') {
        if (int(f.percent, 0, 1000) === null) return reject('invalid', 'percent');
      } else return reject('invalid', 'basis');
      const start = dateStart(f.effectiveFrom);
      if (start === null) return reject('invalid', 'effectiveFrom');
      if (start <= now) return reject('back_dated', 'effectiveFrom');
      if (existing.some((p) => (p.status === 'active' && start <= Date.parse(p.effectiveFrom)) || p.status === 'draft')) return reject('overlap', 'effectiveFrom');
      return ok();
    }
    case 'billing.price.request_activation':
    case 'billing.price.cancel_draft': {
      const row = billing.prices.find((p) => p.price.priceVersionId === f.priceVersionId);
      if (!row) return NOT_FOUND;
      if (row.status !== 'draft' || !row.preview) return reject('not_draft', 'priceVersionId');
      if (command === 'billing.price.cancel_draft') return ok();
      if (Date.parse(row.effectiveFrom) <= now) return reject('back_dated', 'priceVersionId');
      if (!sameDigest(f, row.preview.digest.value)) return reject('digest_mismatch');
      return ok('commerce.activate_price_version');
    }
    case 'billing.invoice.retry': {
      const run = billing.invoiceRuns.find((r) => r.id === f.runId);
      if (!run) return NOT_FOUND;
      return run.failed > 0 ? ok() : reject('invalid', 'runId');
    }
    case 'billing.payout.request_release': {
      const batch = billing.payoutBatches.find((b) => b.id === f.batchId);
      if (!batch) return NOT_FOUND;
      return batch.state === 'awaiting_release' ? ok('billing.release_payout_batch') : reject('invalid', 'batchId');
    }
    case 'billing.payout.reconcile': {
      const batch = billing.payoutBatches.find((b) => b.id === f.batchId);
      if (!batch) return NOT_FOUND;
      if (batch.state !== 'outcome_unknown') return reject('invalid', 'batchId');
      return REF.test((f.evidence ?? '').trim()) ? ok() : reject('invalid', 'evidence');
    }
    case 'billing.credit.issue': {
      if (!REF.test((f.billingAccount ?? '').trim())) return reject('invalid', 'billingAccount');
      const amount = int(f.amountMinor, 1, 100_000_000);
      if (amount === null) return reject('invalid', 'amountMinor');
      if (BigInt(amount) > BigInt(billing.credits.roleCap.minorUnits)) return reject('above_cap', 'amountMinor', [billing.credits.roleCap.minorUnits]);
      return ok();
    }
    case 'billing.refund_policy.save':
      return int(f.refundWindowDays, 0, 365) === null ? reject('invalid', 'refundWindowDays') : ok();
    case 'billing.pack.draft': {
      if (int(f.credits, 1, 1_000_000) === null) return reject('invalid', 'credits');
      if (int(f.priceMinor, 0, 100_000_000) === null) return reject('invalid', 'priceMinor');
      // Credits never expire silently (ADR 012 decision 33): no expiry, or at least 30 days with a reminder.
      if (f.validity === 'none') return ok();
      if (f.validity !== 'days' || int(f.validityDays, 30, 3650) === null) return reject('invalid', 'validityDays');
      return int(f.reminderDays, 7, 90) === null ? reject('invalid', 'reminderDays') : ok();
    }
    case 'billing.pack.request_activation': {
      const pack = billing.credits.packs.find((p) => p.id === f.packId);
      if (!pack) return NOT_FOUND;
      if (pack.status !== 'draft' || !pack.preview) return reject('not_draft', 'packId');
      if (!sameDigest(f, pack.preview.digest.value)) return reject('digest_mismatch');
      return ok('commerce.activate_price_version');
    }
    case 'billing.tax.save': {
      if (stale(f, billing.tax.version)) return reject('stale');
      const region = (f.region ?? '').trim().toUpperCase();
      if (!/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(region)) return reject('invalid', 'region');
      if (ctx.isRestricted(region) || ctx.isRestricted(region.slice(0, 2))) return reject('territory_restricted', 'region');
      if (!oneOf(f.treatment, ['taxable', 'exempt', 'needs_advice'] as const)) return reject('invalid', 'treatment');
      return httpsUrl(f.source) ? ok() : reject('source_required', 'source');
    }

    /* ---------- Communications ---------- */
    case 'comms.domain.add':
      return HOST.test((f.domain ?? '').trim().toLowerCase()) ? ok() : reject('invalid', 'domain');
    case 'comms.domain.recheck':
      return communications.domains.some((d) => d.domain === f.domain) ? ok() : NOT_FOUND;
    case 'comms.template.save':
      if (!communications.templates.some((t) => t.key === f.templateKey)) return NOT_FOUND;
      return ctx.hub.hub.locales.includes(f.lang ?? '') ? ok() : reject('invalid', 'lang');
    case 'comms.template.activate': {
      const template = communications.templates.find((t) => t.key === f.templateKey);
      if (!template) return NOT_FOUND;
      const missing = ctx.hub.hub.locales.filter((l) => !template.locales.includes(l));
      return missing.length ? reject('language_missing', 'templateKey', missing) : ok();
    }
    case 'comms.template.pause': {
      const template = communications.templates.find((t) => t.key === f.templateKey);
      if (!template) return NOT_FOUND;
      return template.status === 'active' ? ok() : reject('invalid', 'templateKey');
    }
    case 'comms.announcement.draft':
      if (!(f.title ?? '').trim()) return reject('invalid', 'title');
      return oneOf(f.kind, ['announcement', 'legal_notice'] as const) ? ok() : reject('invalid', 'kind');
    case 'comms.announcement.send': {
      const item = communications.announcements.find((a) => a.id === f.announcementId);
      if (!item) return NOT_FOUND;
      if (item.state === 'sent') return reject('invalid', 'announcementId');
      // Marketing only with a recorded lawful basis: announcements go to people who opted in, under their consent.
      if (item.kind === 'announcement' && (item.audience !== 'opted_in' || item.lawfulBasis !== 'consent')) return reject('lawful_basis_missing', 'announcementId');
      return ok();
    }
  }
}
