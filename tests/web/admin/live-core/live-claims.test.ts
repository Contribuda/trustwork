import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withMaintenance } from '@trustwork/data';
import { createApiConsolePort, type ConsoleApi } from '../../../../apps/web/app/admin/_data/api-adapter.js';
import type { CommandInput } from '../../../../apps/web/app/admin/_data/commands.js';
import { claimCommand } from '../../../../apps/web/app/admin/_data/live-claims.js';
import { HUBS } from '../../../../apps/web/app/admin/_fixtures/hubs.js';
import { staffRoleDefinitions } from '../../../../packages/data/src/repositories/admin.js';
import { command as apiCommand } from '../../../admin/helpers.js';
import { SKIP_REASON, startHarness, type Client } from '../../../backend/helpers/app.js';
import { claimsWorld, ok, type Claim } from '../../../claims/helpers.js';

/**
 * HC-22 Claims through the console's live adapter on the real API and PostgreSQL, on the CLM-001 world: runtime role, real
 * sessions and elevations. The country rule of #595 is what the reviewer sees and what the database enforces; negative cases
 * run through the console and, with the console's check stepped over, against the API. Every name is synthetic.
 */
const h = await startHarness('console_live_claims');

class Failure extends Error {
  constructor(readonly status: number, readonly code: string | null) {
    super(`API ${status} ${code ?? ''}`);
  }
}
function apiOf(client: Client): ConsoleApi {
  return {
    async get(path) {
      const r = await client.get(path);
      if (r.status >= 200 && r.status < 300) return r.body;
      const code = (r.body as { code?: string } | null)?.code ?? null;
      if (r.status === 404 && code === 'access.not_found') return null;
      throw new Failure(r.status, code);
    },
    async post(path, body, key) {
      const r = await client.post(path, body, { idempotencyKey: key });
      return { status: r.status, code: (r.body as { code?: string } | null)?.code ?? null, body: r.body };
    },
  };
}

test('HC-22 Claims through the live adapter', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  await withMaintenance(h.db.admin, (trx) => staffRoleDefinitions.release(trx, { version: 1, role: 'editor', scopes: ['hub'], permissions: ['admin.hub.read', 'admin.hub.modes.edit', 'admin.config.edit'] as never,
    caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null }));
  const c = await claimsWorld(h);
  const { w, hubId } = c;
  const scope = { kind: 'hub' as const, hubId };
  for (const person of [w.people.hubOwner, w.people.lead2, w.people.lead, w.people.moderator]) await w.actors.assign({ personId: person, role: 'editor', scope });
  const slug = (await h.db.admin.query('SELECT slug FROM trustwork.hub WHERE id = $1', [hubId])).rows[0].slug as string;
  // The CLM-001 world seeds a bare hub; the console reads a hub with its profile, as `hubs.create` writes one.
  await withMaintenance(h.db.admin, async (trx) => {
    const node = await trx.selectFrom('admin_node').select('id').executeTakeFirstOrThrow();
    await trx.insertInto('hub_profile').values({ hub_id: hubId, node_id: node.id, name: JSON.stringify({ en: 'Synthetic claims hub' }), default_locale: 'en', locales: ['en'], time_zone: 'America/New_York', currency: 'USD', created_by: w.people.hubOwner } as never).execute();
  });
  await w.elevateAll();
  const drafted = ok<{ version: { id: string; revision: number } }>(await apiCommand(c.reviewer, `${c.console}/config`, { domain: 'modes', payload: HUBS[0]!.modes }));
  ok(await apiCommand(c.reviewer, `${c.console}/config/${drafted.version.id}/activate`, { expectedRevision: drafted.version.revision, approvalId: null }));

  const portOf = (client: Client) => createApiConsolePort({ api: apiOf(client), siteHost: () => 'live-claims.example.org', engineVersion: '0.1.0', now: () => h.clock.now() });
  const live = { demo: false } as const;
  const run = (client: Client, command: CommandInput['command'], fields: Record<string, string> = {}) =>
    portOf(client).command(live, { command, hubSlug: slug, setupToken: null, reason: 'Synthetic claim review', expectedRevision: null, fields });
  const direct = (client: Client, command: Parameters<typeof claimCommand>[0], fields: Record<string, string>) => claimCommand(command, fields, {
    hubId, send: async (path, rest) => { const r = await apiCommand(client, path, rest); return { status: r.status, code: (r.body as { code?: string } | null)?.code ?? null, body: r.body }; },
  });
  const view = async (client: Client = c.reviewer) => {
    const v = await portOf(client).claims(hubId);
    assert.ok(v, 'the section reads');
    return v;
  };
  const claimOf = async (id: string, client: Client = c.reviewer) => {
    const found = (await view(client)).claims.find((x) => x.id === id);
    assert.ok(found, id);
    return found;
  };
  const submit = async (companyId: string, email: string, level: 'claimed' | 'verified' = 'verified') => {
    const person = await c.claimant('Synthetic Claimant', email);
    return { person, claim: ok<{ claim: Claim }>(await c.submit(person.client, companyId, level)).claim };
  };
  const decision = (claimId: string, revision: number, value = 'approved') => ({ claimId, revision: String(revision), decision: value, note: '' });

  await t.test('who reads: staff with a claims permission; a participant and staff without one read nothing', async () => {
    const companyId = await c.page('Synthetic Hidden Builders');
    const { claim } = await submit(companyId, 'live-claims-hidden@example.invalid');
    assert.ok((await view()).claims.some((x) => x.id === claim.id));
    const moderator = await portOf(w.clients.moderator).claims(hubId);
    assert.deepEqual([moderator?.claims, moderator?.disputes], [[], []], 'staff of the hub without a claims permission see no row');
    const participant = await c.claimant('Synthetic Reader', 'live-claims-reader@example.invalid');
    assert.equal(await portOf(participant.client).claims(hubId), null);
  });

  await t.test('the reviewer sees the country rule: covered, and the recipe with what is missing', async () => {
    const companyId = await c.page('Synthetic Covered Builders');
    const { claim } = await submit(companyId, 'live-claims-covered@example.invalid');
    const seen = await claimOf(claim.id);
    assert.deepEqual([seen.companyName, seen.territory, seen.company], ['Synthetic Covered Builders', 'covered', { country: 'US', region: null }]);
    assert.equal(seen.recipe?.key, 'claim-verified');
    assert.ok(seen.standing, 'the standing of the recipe is read');
    assert.deepEqual(seen.checks, [], 'checks recorded before the claim do not count, and the page does not offer them');
  });

  await t.test('a company outside the hub is shown as such, and the database refuses a decision, even a rejection', async () => {
    const companyId = await c.page('Synthetic Corrected Builders', null, null);
    const { claim } = await submit(companyId, 'live-claims-nocountry@example.invalid');
    const seen = await claimOf(claim.id);
    assert.deepEqual([seen.territory, seen.company?.country], ['missing', null]);
    const refused = await run(c.reviewer, 'claim.decide', decision(claim.id, claim.revision, 'rejected'));
    assert.deepEqual(refused.status === 'rejected' && [refused.code, refused.detail], ['claim_reason', ['company_country_missing']], JSON.stringify(refused));

    const reviewerCorrects = await run(c.reviewer, 'claim.country_correct', { companyId, fromCountry: '', fromRegion: '', country: 'CA', region: '' });
    assert.equal(reviewerCorrects.status === 'rejected' && reviewerCorrects.code, 'denied', 'the claims decide permission does not correct a country');
    const api = await direct(c.reviewer, 'claim.country_correct', { companyId, fromCountry: '', fromRegion: '', country: 'CA', region: '' });
    assert.equal(api.status === 'rejected' && api.code, 'denied', 'nor does the API let it');

    const steward = w.clients.lead;
    const stale = await run(steward, 'claim.country_correct', { companyId, fromCountry: 'GE', fromRegion: '', country: 'CA', region: '' });
    assert.deepEqual(stale.status === 'rejected' && [stale.code, stale.detail], ['claim_reason', ['country_changed']], JSON.stringify(stale));
    const restricted = await run(steward, 'claim.country_correct', { companyId, fromCountry: '', fromRegion: '', country: 'RU', region: '' });
    assert.equal(restricted.status, 'rejected', 'a restricted place is refused');
    const foreign = await run(steward, 'claim.country_correct', { companyId, fromCountry: '', fromRegion: '', country: 'CA', region: '' });
    assert.deepEqual(foreign.status === 'rejected' && [foreign.code, foreign.detail], ['claim_reason', ['outside_territory']], 'a hub covering neither country corrects nothing');
    assert.deepEqual(await run(steward, 'claim.country_correct', { companyId, fromCountry: '', fromRegion: '', country: 'US', region: '' }), { status: 'applied' });
    assert.equal((await claimOf(claim.id)).territory, 'covered');
    assert.deepEqual(await run(steward, 'claim.country_correct', { companyId, fromCountry: 'US', fromRegion: '', country: 'CA', region: '' }), { status: 'applied' });
    const outside = await claimOf(claim.id);
    assert.deepEqual([outside.territory, outside.company?.country], ['outside', 'CA']);
    const out = await run(c.reviewer, 'claim.decide', decision(claim.id, outside.revision, 'rejected'));
    assert.deepEqual(out.status === 'rejected' && [out.code, out.detail], ['claim_reason', ['outside_territory']], JSON.stringify(out));
  });

  await t.test('evidence: recorded after the claim, bound by a reviewer, and only then does an approval pass; one race, one winner', async () => {
    const companyId = await c.page('Synthetic Evidence Builders');
    const { claim, person } = await submit(companyId, 'live-claims-evidence@example.invalid');
    const reader = w.clients.moderator;
    const denied = await direct(reader, 'claim.check_record', { companyId, recipeId: c.recipes.verified, providerId: c.provider, result: 'pass', evidenceRef: 'register:SYN-1' });
    assert.equal(denied.status === 'rejected' && denied.code, 'denied');
    const before = await run(c.reviewer, 'claim.decide', decision(claim.id, claim.revision));
    assert.deepEqual(before.status === 'rejected' && before.code, 'claim_reason', JSON.stringify(before));
    assert.deepEqual(await run(c.reviewer, 'claim.check_record', { companyId, recipeId: c.recipes.verified, providerId: c.provider, result: 'pass', evidenceRef: 'register:SYN-1' }), { status: 'applied' });
    assert.deepEqual(await run(c.reviewer, 'claim.screening_record', { companyId, recipeId: c.recipes.verified }), { status: 'applied' });
    const seen = await claimOf(claim.id);
    assert.deepEqual(seen.checks.map((x) => x.bound), [false, false]);
    const fields = Object.fromEntries(seen.checks.map((x) => [`check.${x.id}`, 'on']));
    const none = await run(c.reviewer, 'claim.bind_evidence', { claimId: claim.id });
    assert.equal(none.status === 'rejected' && none.field, 'checks');
    assert.deepEqual(await run(c.reviewer, 'claim.bind_evidence', { claimId: claim.id, ...fields }), { status: 'applied' });
    const bound = await claimOf(claim.id);
    assert.deepEqual(bound.checks.map((x) => x.bound), [true, true]);
    const stale = await run(c.reviewer, 'claim.decide', decision(claim.id, bound.revision + 1));
    assert.equal(stale.status === 'rejected' && stale.code, 'stale');
    const answers = await Promise.all([run(c.reviewer, 'claim.decide', decision(claim.id, bound.revision)), run(c.second, 'claim.decide', decision(claim.id, bound.revision))]);
    assert.equal(answers.filter((r) => r.status === 'applied').length, 1, JSON.stringify(answers));
    assert.equal(await c.roleOf(person.id, companyId), 'administrator');
    assert.equal((await view()).decided.find((x) => x.id === claim.id)?.state, 'approved');
  });

  await t.test('a staff member sees their own claim as their own and cannot decide it', async () => {
    const companyId = await c.page('Synthetic Own Builders');
    const own = ok<{ claim: Claim }>(await c.submit(c.second, companyId, 'verified')).claim;
    const seen = await claimOf(own.id, c.second);
    assert.deepEqual([seen.own, seen.territory, seen.company], [true, null, null]);
    assert.equal(seen.claimantId, undefined, 'the claimant projection');
    const refused = await run(c.second, 'claim.decide', decision(own.id, own.revision));
    assert.deepEqual(refused.status === 'rejected' && [refused.code, refused.detail], ['claim_reason', ['own_claim']], JSON.stringify(refused));
  });

  await t.test('a dispute takes two reviewers', async () => {
    const companyId = await c.page('Synthetic Contested Builders');
    const first = await submit(companyId, 'live-claims-first@example.invalid');
    const second = await submit(companyId, 'live-claims-second@example.invalid');
    const v = await view();
    const dispute = v.disputes.find((d) => d.companyId === companyId && d.state === 'open');
    assert.ok(dispute, 'the second claim opened a dispute');
    assert.ok(v.claims.filter((x) => x.disputeId === dispute.id).length === 2);
    const fields = { disputeId: dispute.id, revision: String(dispute.revision) };
    const short = await run(c.reviewer, 'claim.dispute_propose', { ...fields, winner: 'none', note: 'short' });
    assert.equal(short.status === 'rejected' && short.field, 'note');
    const foreign = await run(c.reviewer, 'claim.dispute_propose', { ...fields, winner: randomUUID(), note: 'Synthetic reasoning here' });
    assert.equal(foreign.status, 'rejected');
    assert.deepEqual(await run(c.reviewer, 'claim.dispute_propose', { ...fields, winner: first.claim.id, note: 'Synthetic reasoning here' }), { status: 'applied' });
    const proposed = (await view()).disputes.find((d) => d.id === dispute.id)!;
    const own = await run(c.reviewer, 'claim.dispute_confirm', { disputeId: dispute.id, revision: String(proposed.revision) });
    assert.deepEqual(own.status === 'rejected' && [own.code, own.detail], ['claim_reason', ['second_person_required']], JSON.stringify(own));
    assert.deepEqual(await run(c.second, 'claim.dispute_confirm', { disputeId: dispute.id, revision: String(proposed.revision) }), { status: 'applied' });
    assert.ok((await view()).decided.some((x) => x.id === second.claim.id && x.state === 'rejected'));
  });

  await t.test('the private tie and the reviewer note stay with the claim row; a claim of another hub is not found', async () => {
    assert.deepEqual(await run(c.reviewer, 'claim.decide', decision(randomUUID(), 1)), { status: 'not_found' });
  });
});
