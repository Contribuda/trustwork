import assert from 'node:assert/strict';
import { withMaintenance } from '@trustwork/data';
import { staffRoleDefinitions } from '../../packages/data/src/repositories/admin.js';
import { addLogins, buildHttpWorld, command, signIn, type AdminWorldHttp } from '../admin/helpers.js';
import { Client, type Harness, type Response } from '../backend/helpers/app.js';
import { activateBaseline, screen } from '../screening-gates/helpers.js';

const PERMISSIONS = ['admin.claims.read', 'admin.claims.decide', 'admin.claims.policy.edit', 'admin.claims.revoke', 'admin.sources.read', 'admin.sources.manage'] as const;

/** Parses a successful response. */
export function ok<T>(r: Response): T {
  assert.ok(r.status >= 200 && r.status < 300, `${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}

export type Claim = { id: string; state: string; revision: number; domainTie: string | null; disputeId?: string | null; waitingUntil: string | null; claimantId?: string; companyId?: string; recipeId?: string };

/**
 * The HTTP world of the claim suites, on the ADM-001 world: the API serves the world's hub, every staff session is
 * elevated, and two people (hubOwner, lead2) are trust reviewers there; `ops` is a trust reviewer of the other hub only,
 * and the moderator is staff here without any claims permission. Register and screening results reach a page through
 * the verification routes and SANC-003's own code path. Every person, company, domain and number is synthetic.
 */
export async function claimsWorld(h: Harness) {
  await withMaintenance(h.db.admin, async (trx) => {
    await staffRoleDefinitions.release(trx, { version: 1, role: 'trust-reviewer', scopes: ['hub'], permissions: [...PERMISSIONS], caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced',
      releasedBy: null });
  });
  const w: AdminWorldHttp = await buildHttpWorld(h);
  const hubId = w.world.hubId;
  const otherHubId = w.world.otherHubId;
  await w.actors.assign({ personId: w.people.hubOwner, role: 'trust-reviewer', scope: { kind: 'hub', hubId } });
  await w.actors.assign({ personId: w.people.lead2, role: 'trust-reviewer', scope: { kind: 'hub', hubId } });
  await w.actors.assign({ personId: w.people.ops, role: 'trust-reviewer', scope: { kind: 'hub', hubId: otherHubId } });
  await w.elevateAll();
  await activateBaseline(h.db.admin);
  const reviewer = w.clients.hubOwner;
  const second = w.clients.lead2;
  const console_ = `/v1/admin/hubs/${hubId}`;

  const recipeFor = async (key: string, trigger: 'claim_claimed' | 'claim_verified') => {
    const drafted = ok<{ recipe: { id: string; revision: number } }>(await command(reviewer, `${console_}/verification/recipes`, { key, subjectKind: 'company', trigger, recheckMonths: 12,
      badgeCategories: ['register_record_matches', 'sanctions_screening_clear'], steps: [{ check: 'register_match', required: true }, { check: 'sanctions_screening', required: true }] }));
    ok(await command(reviewer, `${console_}/verification/recipes/${drafted.recipe.id}/activate`, { expectedRevision: drafted.recipe.revision }));
    return drafted.recipe.id;
  };
  const recipes = { claimed: await recipeFor('claim-claimed', 'claim_claimed'), verified: await recipeFor('claim-verified', 'claim_verified') };
  const provider = ok<{ provider: { id: string } }>(await command(reviewer, `${console_}/verification/providers`, { checkType: 'register_match', adapter: 'synthetic_claims_register', mode: 'fake', retentionDays: 365,
    legalBasis: 'statutory_public_register', costMinor: null })).provider.id;

  /** A synthetic page that passes both recipes (a register match and clear screening); unclaimed. */
  const page = async (name: string, domain: string | null = null): Promise<string> => {
    const id = await withMaintenance(h.db.admin, async (trx) => (await trx.insertInto('company').values({ display_name: name, claim_status: 'unclaimed', verified_domains: domain ? [domain] : [] })
      .returning('id').executeTakeFirstOrThrow()).id);
    await screen(h.db.admin, { kind: 'company', id });
    for (const recipeId of Object.values(recipes)) {
      ok(await command(reviewer, `${console_}/verification/checks`, { subject: { kind: 'company', id }, recipeId, providerId: provider, result: 'pass', evidenceRef: 'register:SYN-CLAIM-1' }));
      ok(await command(reviewer, `${console_}/verification/checks/screening`, { subject: { kind: 'company', id }, recipeId }));
    }
    return id;
  };

  /** A synthetic person with a verified login, signed in and screened clear. */
  const claimant = async (name: string, email: string): Promise<{ id: string; client: Client }> => {
    const id = await withMaintenance(h.db.admin, async (trx) => (await trx.insertInto('person').values({ display_name: name }).returning('id').executeTakeFirstOrThrow()).id);
    await addLogins(h, [[id, email]]);
    await screen(h.db.admin, { kind: 'person', id });
    const client = new Client(w.app);
    await signIn(client, email);
    return { id, client };
  };

  const submit = (client: Client, companyId: string, level: 'claimed' | 'verified', tie: { kind: string; email: string } | null = null): Promise<Response> =>
    client.post('/v1/claims', { hubId, companyId, level, recipeId: recipes[level], tie });
  const decideOnly = (client: Client, claim: Pick<Claim, 'id' | 'revision'>, decision: 'approved' | 'rejected' = 'approved', officerMatch = false): Promise<Response> =>
    command(client, `${console_}/claims/requests/${claim.id}/decide`, { expectedRevision: claim.revision, decision, officerMatch, note: null });
  /** The checks of the claim's recipe, recorded now, after the claim was submitted. */
  const freshChecks = async (companyId: string, recipeId: string): Promise<string[]> => {
    const subject = { kind: 'company', id: companyId };
    const register = ok<{ check: { id: string } }>(await command(reviewer, `${console_}/verification/checks`, { subject, recipeId, providerId: provider, result: 'pass', evidenceRef: 'register:SYN-CLAIM-1' })).check.id;
    const screening = ok<{ check: { id: string } }>(await command(reviewer, `${console_}/verification/checks/screening`, { subject, recipeId })).check.id;
    return [register, screening];
  };
  const bind = (client: Client, claimId: string, checkIds: string[]): Promise<Response> => command(client, `${console_}/claims/requests/${claimId}/evidence`, { checkIds });
  const prove = async (claim: Required<Pick<Claim, 'id' | 'companyId' | 'recipeId'>>): Promise<void> => {
    ok(await bind(reviewer, claim.id, await freshChecks(claim.companyId, claim.recipeId)));
  };
  /** A reviewer's approval as it happens in the console: fresh evidence bound to the claim, then the decision. */
  const decide = async (client: Client, claim: Pick<Claim, 'id' | 'revision' | 'companyId' | 'recipeId'>, decision: 'approved' | 'rejected' = 'approved', officerMatch = false): Promise<Response> => {
    if (decision === 'approved' && claim.companyId && claim.recipeId) await prove({ id: claim.id, companyId: claim.companyId, recipeId: claim.recipeId });
    return decideOnly(client, claim, decision, officerMatch);
  };
  const statusOf = async (companyId: string) => (await withMaintenance(h.db.admin, (trx) => trx.selectFrom('company').select('claim_status').where('id', '=', companyId).executeTakeFirstOrThrow())).claim_status;
  const roleOf = async (personId: string, companyId: string) => (await withMaintenance(h.db.admin, (trx) => trx.selectFrom('membership').select('role').where('person_id', '=', personId).where('company_id', '=', companyId)
    .where('status', '=', 'active').executeTakeFirst()))?.role ?? null;
  const notices = async (client: Client) => ok<{ items: Array<{ templateKey: string; params: Record<string, string> }> }>(await client.get('/v1/notifications')).items.filter((n) => n.templateKey.startsWith('claims.'));

  return { w, hubId, otherHubId, console: console_, reviewer, second, recipes, provider, page, claimant, submit, decide, decideOnly, freshChecks, bind, prove, statusOf, roleOf, notices };
}
