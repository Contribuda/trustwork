import { sql } from 'kysely';
import { findServingHub } from '../agent-modules/serving-hub.js';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { computeDigest, mandateChangeAllowed, MandateV2Schema, type Grantee, type Principal } from '../../deps/contracts.js';
import { CompanyMandateTermsSchema, type CompanyMandateTerms, type ConfigureRepresentativeCommandSchema, type GrantCompanyMandateCommandSchema, type ReconfirmCompanyMandateCommandSchema, type RevisionCommandSchema } from './contracts.js';
import type { Transaction } from '../../deps/data.js';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import type { AppContext } from '../identity/context.js';
import type { PrincipalService } from '../identity/principal.service.js';
import { AgentsBase, companyMandateView, isUuid, iso, isoOrNull, representativeView } from './common.js';
import { companyMandates, mandateDigest, mandates, representatives, stops, type CompanyMandateRow } from './deps.js';

type In<T extends z.ZodType> = z.infer<T>;
const NOBODY = '00000000-0000-0000-0000-000000000000';

/** trustwork-digest-1 of what a company mandate grants: the grantee and the terms. A re-confirmation repeats it. */
export function companyTermsDigest(grantee: Grantee, terms: CompanyMandateTerms): string {
  return computeDigest({ kind: 'trustwork.agents.company_mandate_terms', grantee, terms }).value;
}
function granteeOf(row: Pick<CompanyMandateRow, 'executor_kind' | 'executor_person_id' | 'company_id'>): Grantee {
  return row.executor_kind === 'company_representative' ? { kind: 'company_representative', companyId: row.company_id } : { kind: 'colleague_agent', personId: row.executor_person_id as string, companyId: row.company_id };
}

/**
 * The company's one standing representative and company mandates (AGT-001), configured on the company page
 * ("Company" -> "Representative"). There is no list of representatives and no agent management screen: a company has at
 * most one, always with an accountable person; its authority comes only from company mandates granted on the
 * first-party form by members holding company.deals.manage. Any company administrator suspends it instantly.
 */
export class RepresentativeService extends AgentsBase {
  constructor(ctx: AppContext, principals: PrincipalService) {
    super(ctx, principals);
  }

  /** What blocks dispatch beyond the stored state: an engaged node switch, or a switch of this hub. */
  private async blockedBy(trx: Transaction): Promise<'hub_kill_switch' | 'node_kill_switch' | null> {
    const node = await stops.blockedBy(trx, { hubId: randomUUID(), moduleKey: 'representative', action: 'communicate', personId: NOBODY, connectionId: null });
    if (node) return 'node_kill_switch';
    const binding = await findServingHub(trx, this.ctx.config.publicOrigin);
    if (!binding) return null;
    const hub = await stops.blockedBy(trx, { hubId: binding.hubId, moduleKey: 'representative', action: 'communicate', personId: NOBODY, connectionId: null });
    return hub ? 'hub_kill_switch' : null;
  }

  view(companyId: string, state: RequestState) {
    return this.run(state, async (trx) => {
      if (!isUuid(companyId)) throw new ApiError('access.not_found', 'company not found');
      const rep = await representatives.get(trx, companyId);
      const mandatesOfCompany = await companyMandates.listForCompany(trx, companyId);
      const history = rep ? await representatives.accountability(trx, rep.id) : [];
      return {
        representative: rep ? representativeView(rep, await this.blockedBy(trx)) : null,
        accountability: history.map((h) => ({ personId: h.person_id, from: iso(h.from_at), to: isoOrNull(h.to_at), endedReason: h.ended_reason })),
        companyMandates: mandatesOfCompany.map((m) => companyMandateView(m, this.now())),
      };
    });
  }
  /** Company mandates the person's own agent executes as a colleague. */
  myCompanyMandates(state: RequestState) {
    return this.run(state, async (trx, p) => ({ companyMandates: (await companyMandates.listForExecutor(trx, p.personId)).map((m) => companyMandateView(m, this.now())) }));
  }
  listCompanyMandates(companyId: string, state: RequestState) {
    return this.run(state, async (trx) => {
      if (!isUuid(companyId)) throw new ApiError('access.not_found', 'company not found');
      return { companyMandates: (await companyMandates.listForCompany(trx, companyId)).map((m) => companyMandateView(m, this.now())) };
    });
  }

  configure(companyId: string, body: In<typeof ConfigureRepresentativeCommandSchema>, state: RequestState) {
    return this.run(state, async (trx, p) => {
      const company = this.employer(p, companyId);
      if (!isUuid(body.accountablePersonId)) throw new ApiError('access.not_found', 'person not found');
      const rep = await representatives.configure(trx, company, body.accountablePersonId, body.expectedRevision);
      await this.audit(trx, p, state, 'agents.representative_configured', 'company_representative', rep.id, { accountablePersonId: body.accountablePersonId, status: rep.status }, company);
      return representativeView(rep, await this.blockedBy(trx));
    });
  }
  accept(companyId: string, state: RequestState) {
    return this.simple(companyId, state, 'accepted', (trx) => representatives.accept(trx, companyId));
  }
  suspend(companyId: string, state: RequestState) {
    return this.simple(companyId, state, 'suspended', (trx) => representatives.suspend(trx, companyId));
  }
  resume(companyId: string, body: In<typeof RevisionCommandSchema>, state: RequestState) {
    return this.simple(companyId, state, 'resumed', (trx) => representatives.resume(trx, companyId, body.expectedRevision));
  }
  disable(companyId: string, state: RequestState) {
    return this.simple(companyId, state, 'disabled', (trx) => representatives.disable(trx, companyId));
  }
  private simple(companyId: string, state: RequestState, verb: string, fn: (trx: Transaction) => ReturnType<typeof representatives.accept>) {
    return this.run(state, async (trx, p) => {
      this.employer(p, companyId);
      const rep = await fn(trx);
      await this.audit(trx, p, state, `agents.representative_${verb}`, 'company_representative', rep.id, { status: rep.status, reason: rep.suspension_reason }, companyId);
      return representativeView(rep, await this.blockedBy(trx));
    });
  }

  /** Grants a company mandate on the first-party form (step-up route): the AST-001 mandate and its company record in one transaction. */
  grant(companyId: string, body: In<typeof GrantCompanyMandateCommandSchema>, state: RequestState) {
    return this.run(state, async (trx, p) => {
      const company = this.employer(p, companyId);
      if (body.executor.kind === 'colleague_agent' && !isUuid(body.executor.personId)) throw new ApiError('access.not_found', 'person not found');
      const grantee: Grantee = body.executor.kind === 'company_representative' ? { kind: 'company_representative', companyId: company } : { kind: 'colleague_agent', personId: body.executor.personId, companyId: company };
      const mandate = await this.confirmCompanyMandate(trx, p, state, company, grantee, body.terms);
      const cm = await companyMandates.grant(trx, mandate.id, body.terms, companyTermsDigest(grantee, body.terms));
      await this.audit(trx, p, state, 'agents.company_mandate_granted', 'company_mandate', cm.id, { mandateId: mandate.id, executor: cm.executor_kind, actions: body.terms.actions }, company);
      return companyMandateView(cm, this.now());
    });
  }
  /** Another authorized member re-confirms the identical terms within the window (step-up route); never widens. */
  reconfirm(companyId: string, id: string, body: In<typeof ReconfirmCompanyMandateCommandSchema>, state: RequestState) {
    return this.run(state, async (trx, p) => {
      const company = this.employer(p, companyId);
      const cm = isUuid(id) ? await companyMandates.get(trx, id) : undefined;
      if (!cm || cm.company_id !== company) throw new ApiError('access.not_found', 'company mandate not found');
      if (body.termsDigest.value !== cm.terms_digest) throw new ApiError('access.approval_digest_mismatch', 'the re-confirmation repeats exactly the terms shown', { reason: 'digest_mismatch' });
      if (cm.status !== 'awaiting_reconfirmation') throw new ApiError('validation.revision_conflict', 'the company mandate is not waiting for re-confirmation', { reason: 'not_awaiting_reconfirmation' });
      const terms = CompanyMandateTermsSchema.parse(cm.terms);
      const mandate = await this.confirmCompanyMandate(trx, p, state, company, granteeOf(cm), terms);
      const updated = await companyMandates.reconfirm(trx, cm.id, mandate.id, cm.terms_digest);
      await this.audit(trx, p, state, 'agents.company_mandate_reconfirmed', 'company_mandate', cm.id, { mandateId: mandate.id }, company);
      return companyMandateView(updated, this.now());
    });
  }
  revoke(companyId: string, id: string, body: In<typeof RevisionCommandSchema>, state: RequestState) {
    return this.run(state, async (trx, p) => {
      const company = this.employer(p, companyId);
      if (!isUuid(id)) throw new ApiError('access.not_found', 'company mandate not found');
      const cm = await companyMandates.revoke(trx, id, body.expectedRevision);
      await this.audit(trx, p, state, 'agents.company_mandate_revoked', 'company_mandate', cm.id, { reason: cm.status_reason }, company);
      return companyMandateView(cm, this.now());
    });
  }

  private async confirmCompanyMandate(trx: Transaction, p: Principal, state: RequestState, company: string, grantee: Grantee, terms: CompanyMandateTerms) {
    const parsed = MandateV2Schema.safeParse({
      id: randomUUID(), schemaVersion: 2, principal: { personId: p.personId, onBehalfOf: { kind: 'company', id: company } }, grantee, ...terms,
      confirmation: { via: 'first_party_form', personId: p.personId, at: iso(this.now()), stepUp: this.steppedUp(state) }, status: 'active', revision: 1, revokedAt: null,
    });
    if (!parsed.success) throw new ApiError('validation.schema', 'the mandate is not valid', { reason: 'mandate_invalid', issues: parsed.error.issues.slice(0, 10).map((i) => i.message) });
    const verdict = mandateChangeAllowed({ kind: 'person', personId: p.personId, via: 'first_party_form' }, null, parsed.data);
    if (verdict !== 'ok') throw new ApiError('access.forbidden', verdict, { reason: verdict });
    const row = await mandates.confirm(trx, { snapshot: parsed.data, contexts: parsed.data.contexts, digest: mandateDigest(parsed.data), expectedRevision: null, stepUp: this.steppedUp(state), proposalId: null });
    const binding = await findServingHub(trx, this.ctx.config.publicOrigin);
    if (binding && state.session) await sql`SELECT trustwork.agent_modules_bind_mandate(${row.id}::uuid,${binding.id}::uuid,${state.session.id}::uuid)`.execute(trx);
    return row;
  }
}
