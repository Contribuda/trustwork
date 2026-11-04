import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { createPool, withMaintenance, type DataPool } from '@trustwork/data';
import { computeDigest, type HubConfigDomain } from '@trustwork/contracts';
import { ApprovalChangeSchema, type ApprovalChange } from '../../packages/contracts/src/approval-change.js';
import { configActivationDigestInput, credentialActivationDigestInput, legalActivationDigestInput, lifecycleTransitionDigestInput } from '../../packages/contracts/src/hub-core.js';
import { adminDigests, approvals, staffAssignments, staffRoleDefinitions } from '../../packages/data/src/repositories/admin.js';
import { hubConfig, hubs, legalDocuments, providerCredentials } from '../../packages/data/src/repositories/hubs.js';
import { staffLifecycle } from '../../packages/data/src/repositories/staff-lifecycle.js';
import { provisionTestDatabase, SKIP_REASON } from '../data/helpers/postgres.js';
import { assertCardBinds } from '../admin/approval-change-helpers.js';
import { actors, buildHubWorld, rejects, syncKernel, US_HUB } from './helpers.js';

const db = await provisionTestDatabase('approval_change');

/**
 * HUBC-007 audit fix on real PostgreSQL under the runtime role: `admin_approval_change` answers what an approval's digest
 * binds, from the object or from a digest input the database proved, and never from the requester's reason. Every person,
 * hub and document is synthetic.
 */
test('what a second person approves is what the digest binds (HUBC-007)', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  await db.migrate();
  await syncKernel(db.admin);
  await db.createAppLogin();
  const runtime: DataPool = createPool({ ...db.appConfig, max: 6 });
  t.after(async () => { await runtime.end(); await db.close(); });
  const w = await buildHubWorld(db.admin);
  const a = actors(db.admin, runtime, w);
  const p = w.people;
  await a.assignSensitive({ personId: p.operator, role: 'node-operator', scope: { kind: 'node', nodeId: w.nodeId } });
  const hub = (await a.createHub(`synthetic-change-${randomBytes(3).toString('hex')}`, { ...US_HUB, countryPack: null })).hub_id;
  const scope = { kind: 'hub', hubId: hub } as const;
  await a.assignSensitive({ personId: p.owner, role: 'hub-owner', scope });
  await a.assignSensitive({ personId: p.officer, role: 'compliance-officer', scope });
  await a.assign({ personId: p.moderator, role: 'moderator', scope });

  const change = async (by: string, approvalId: string): Promise<ApprovalChange> => ApprovalChangeSchema.parse((await a.as(by, (trx) => approvals.changes(trx, [approvalId]))).get(approvalId));
  const field = (c: ApprovalChange, name: string) => c.fields.find((f) => f.field === name);
  /** Asks exactly as the owning routes do: the digest, and the input it was computed from when the caller has it. */
  const ask = async (by: string, action: string, input: unknown, withSubject = true) =>
    a.cmd(by, (trx, ctx) => approvals.request(trx, { ...ctx, reasonText: 'Weekend moderator' }, { action, scope, actionDigest: computeDigest(input).value, ...(withSubject ? { subject: input } : {}) }));

  await t.test('a role for a person: the reason says one thing, the digest binds another, and the digest is what is shown', async () => {
    const input = adminDigests.assignmentInput({ breakglass: false, personId: p.outsider, role: 'hub-owner', scope, definitionVersion: 1, validForSeconds: 7 * 86_400 });
    const request = await ask(p.founder, 'staff.assign_sensitive_role', input);
    assert.equal(request.reason, 'Weekend moderator');
    const c = await change(p.founder2, request.id);
    assert.deepEqual([c.bound, c.current, c.currentDigest], [true, true, request.action_digest]);
    assert.deepEqual(field(c, 'role')?.after, { kind: 'key', key: 'roles.hub-owner' });
    assert.deepEqual(field(c, 'personId')?.after, { kind: 'person', personId: p.outsider, displayName: 'Synthetic outsider', maskedEmail: null });
    assert.deepEqual(field(c, 'scope.kind')?.after, { kind: 'key', key: 'approvals.scopes.hub' });
    assert.deepEqual(field(c, 'validForSeconds')?.after, { kind: 'duration', seconds: 7 * 86_400 });
    await assertCardBinds(db.admin, request.id);
    assert.ok(!JSON.stringify(c).includes('Weekend'), 'the requester\'s text is no part of the change');
  });

  await t.test('a role through an invitation and through an activation: read from the row that asked, digest checked', async () => {
    const email = `change.${randomBytes(3).toString('hex')}@invite.example.invalid`;
    await withMaintenance(db.admin, async (trx) => {
      await trx.insertInto('email_binding').values({ person_id: p.otherOwner, email_normalized: email, is_primary: true, verified_at: new Date() }).execute();
      await trx.insertInto('second_factor').values({ id: randomUUID(), person_id: p.otherOwner, kind: 'totp', state: 'active', secret_sealed: randomBytes(48), activated_at: new Date() } as never).execute();
    });
    const invited = await a.cmd(p.founder, (trx, ctx) => staffLifecycle.invite(trx, ctx, { email, role: 'compliance-officer', scope, definitionVersion: 1, validForSeconds: null }));
    await a.as(p.otherOwner, (trx) => staffLifecycle.respond(trx, invited.id, true));
    const applied = await a.cmd(p.founder, (trx, ctx) => staffLifecycle.apply(trx, ctx, invited.id));
    const c = await change(p.founder2, applied.invitation.approval_id!);
    assert.equal(c.bound, true);
    assert.deepEqual(field(c, 'role')?.after, { kind: 'key', key: 'roles.compliance-officer' });
    assert.deepEqual(field(c, 'personId')?.after, { kind: 'person', personId: p.otherOwner, displayName: 'Synthetic otherOwner', maskedEmail: 'ch***@invite.example.invalid' });
    assert.deepEqual(field(c, 'validForSeconds')?.after, { kind: 'key', key: 'approvals.noEndDate' });
    await assertCardBinds(db.admin, applied.invitation.approval_id!);
    await a.cmd(p.founder, (trx, ctx) => staffLifecycle.withdraw(trx, ctx, invited.id));
    assert.equal((await change(p.founder, applied.invitation.approval_id!)).current, false, 'a withdrawn invitation voids what it asked for');
  });

  await t.test('a residency change, also when asked through the generic route: before and after, from the version', async () => {
    const first = await a.cmd(p.owner, (trx, ctx) => hubConfig.draft(trx, ctx, hub, 'residency', { hostingCountry: 'US', hostingRegion: null, personalDataCountries: ['US'] }));
    const firstInput = configActivationDigestInput({ id: first.id, hubId: hub, domain: 'residency', version: first.version, payloadDigest: first.payload_digest });
    const asked = await ask(p.officer, 'hub.change_residency', firstInput, false);
    const before = await change(p.owner, asked.id);
    assert.deepEqual(field(before, 'hostingCountry'), { field: 'hostingCountry', before: { kind: 'none' }, after: { kind: 'text', value: 'US' } });
    await a.cmd(p.owner, (trx, ctx) => approvals.decide(trx, ctx, asked.id, 'approve', asked.action_digest));
    await a.cmd(p.officer, (trx, ctx) => hubConfig.activate(trx, ctx, first.id, null, asked.id));

    const moved = await a.cmd(p.owner, (trx, ctx) => hubConfig.draft(trx, ctx, hub, 'residency', { hostingCountry: 'ES', hostingRegion: null, personalDataCountries: ['ES', 'US'] }));
    const input = configActivationDigestInput({ id: moved.id, hubId: hub, domain: 'residency', version: moved.version, payloadDigest: moved.payload_digest });
    const request = await ask(p.officer, 'hub.change_residency', input);
    const c = await change(p.owner, request.id);
    assert.deepEqual(field(c, 'hostingCountry'), { field: 'hostingCountry', before: { kind: 'text', value: 'US' }, after: { kind: 'text', value: 'ES' } });
    assert.deepEqual(field(c, 'personalDataCountries'), { field: 'personalDataCountries', before: { kind: 'text', value: 'US' }, after: { kind: 'text', value: 'ES, US' } });
    assert.deepEqual(field(c, 'configVersion'), { field: 'configVersion', before: { kind: 'text', value: '1' }, after: { kind: 'text', value: '2' } });
    assert.equal(field(c, 'hostingRegion'), undefined, 'what does not change is not listed');
    await assertCardBinds(db.admin, request.id);

    // The version moves on: the request is void, and what it bound stays readable.
    await a.cmd(p.owner, (trx, ctx) => hubConfig.cancel(trx, ctx, moved.id));
    const gone = await change(p.owner, request.id);
    assert.deepEqual([gone.bound, gone.current, gone.currentDigest], [true, false, null]);
  });

  await t.test('other sensitive domains: the digest of the version is the proof, whichever action it is', async () => {
    const domains: Array<[HubConfigDomain, string, Record<string, unknown>, string]> = [
      ['egress', 'egress.allow_private_class', { defaultNonPublic: 'deny' }, 'defaultNonPublic'],
      ['jurisdiction', 'jurisdiction.activate_settings', { addedRestrictedPlaces: [{ code: 'VE', legalBasis: { citation: 'Synthetic order 14-1', url: null } }] }, 'addedRestrictedPlaces'],
    ];
    for (const [domain, action, payload, key] of domains) {
      const v = await a.cmd(p.owner, (trx, ctx) => hubConfig.draft(trx, ctx, hub, domain, payload));
      const request = await ask(p.officer, action, configActivationDigestInput({ id: v.id, hubId: hub, domain, version: v.version, payloadDigest: v.payload_digest }), false);
      const c = await change(p.owner, request.id);
      assert.equal(c.bound, true, action);
      assert.ok(c.fields.some((f) => f.field === key || f.field.startsWith(`${key}.`)), `${action} shows ${key}`);
      await assertCardBinds(db.admin, request.id);
    }
  });

  await t.test('a transition: where the hub goes, and void once the hub has moved', async () => {
    const row = await a.as(p.owner, (trx) => hubs.get(trx, hub));
    const input = lifecycleTransitionDigestInput({ hubId: hub, from: row!.lifecycle as 'preparing', to: 'soft_launch', revision: row!.revision });
    const request = await ask(p.owner, 'hub.transition_soft_launch', input);
    const c = await change(p.officer, request.id);
    assert.deepEqual(field(c, 'lifecycle'), { field: 'lifecycle', before: { kind: 'key', key: `lifecycle.${row!.lifecycle}` }, after: { kind: 'key', key: 'lifecycle.soft_launch' } });
    assert.deepEqual(c.apply, { kind: 'lifecycle', to: 'soft_launch', revision: row!.revision });
    assert.deepEqual([c.current, c.currentDigest], [true, request.action_digest]);
    await assertCardBinds(db.admin, request.id);

    await a.cmd(p.owner, (trx, ctx) => hubs.transition(trx, ctx, hub, 'preparing', row!.revision, null));
    const stale = await change(p.officer, request.id);
    assert.deepEqual([stale.bound, stale.current, stale.currentDigest], [true, false, null]);
    assert.deepEqual(field(stale, 'lifecycle')?.before, { kind: 'key', key: `lifecycle.${row!.lifecycle}` }, 'what was bound stays what was bound');
  });

  await t.test('a legal document and a credential: every term the digest binds', async () => {
    const d = await a.cmd(p.owner, (trx, ctx) => legalDocuments.draft(trx, ctx, hub, { kind: 'terms', locale: 'en', body: 'Synthetic terms' }));
    const counsel = await a.cmd(p.owner, (trx, ctx) => legalDocuments.recordCounselApproval(trx, ctx, hub, { documentVersionIds: [d.id], counselName: 'Synthetic Counsel', firm: 'Synthetic Firm LLP', approvedOn: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), scopeNote: 'Synthetic scope' }));
    const request = await ask(p.officer, 'legal.activate_document_version', legalActivationDigestInput({ id: d.id, hubId: hub, kind: 'terms', locale: 'en', version: d.version, bodyDigest: d.body_digest, counselApprovalId: counsel.id }));
    const c = await change(p.owner, request.id);
    assert.deepEqual(field(c, 'kind')?.after, { kind: 'key', key: 'hub.legal.kinds.terms' });
    assert.deepEqual(field(c, 'locale')?.after, { kind: 'text', value: 'en' });
    assert.deepEqual(field(c, 'version')?.after, { kind: 'text', value: '1' });
    await assertCardBinds(db.admin, request.id);
    assert.match(JSON.stringify(field(c, 'counsel')), /Synthetic Counsel, Synthetic Firm LLP/);

    const credential = await a.cmd(p.owner, (trx, ctx) => providerCredentials.register(trx, ctx, hub, { provider: 'synthetic_mail', adapter: 'synthetic_smtp', mode: 'live', secretStore: 'env', secretRef: 'SYNTHETIC_SECRET_NAME' }));
    const asked = await ask(p.officer, 'providers.enable_non_fake', credentialActivationDigestInput({ id: credential.id, hubId: hub, provider: credential.provider, adapter: credential.adapter, mode: 'live', secretStore: credential.secret_store, secretRef: credential.secret_ref }), false);
    const shown = await change(p.owner, asked.id);
    assert.deepEqual(field(shown, 'provider')?.after, { kind: 'text', value: 'synthetic_mail' });
    assert.deepEqual(field(shown, 'secretRef')?.after, { kind: 'text', value: 'SYNTHETIC_SECRET_NAME' }, 'the name of the secret, as the credential view shows staff; the database refuses a value shaped like a secret');
    await assertCardBinds(db.admin, asked.id);
  });

  await t.test('an egress rule: what no row holds yet is read from the proved digest input', async () => {
    const input = { action: 'egress.allow_private_class', object: 'egress_rule', hubId: hub, connectionId: randomUUID(), dataClass: 'person_private', decision: 'allow', requireInResidency: true, requireZeroRetention: true, version: 1 };
    const request = await ask(p.owner, 'egress.allow_private_class', input);
    const c = await change(p.officer, request.id);
    assert.deepEqual(field(c, 'dataClass')?.after, { kind: 'text', value: 'person_private' });
    await assertCardBinds(db.admin, request.id);
    const later = await ask(p.owner, 'egress.allow_private_class', { ...input, version: 2 });
    assert.equal((await change(p.officer, later.id)).current, false, 'not the next version of the rule');
  });

  await t.test('a change deep in a long payload shows as that change, and what cannot be shown whole cannot be approved', async () => {
    const filler = 'Synthetic long value '.repeat(40);
    const first = await a.cmd(p.owner, (trx, ctx) => hubConfig.draft(trx, ctx, hub, 'federation', { filler, nested: { deep: { limit: 1 } }, peers: [{ host: 'a.example.invalid', level: 'identity' }] }));
    const asked = await ask(p.officer, 'federation.raise_peering_level', configActivationDigestInput({ id: first.id, hubId: hub, domain: 'federation', version: first.version, payloadDigest: first.payload_digest }), false);
    await a.cmd(p.owner, (trx, ctx) => approvals.decide(trx, ctx, asked.id, 'approve', asked.action_digest));
    await a.cmd(p.officer, (trx, ctx) => hubConfig.activate(trx, ctx, first.id, null, asked.id));

    const second = await a.cmd(p.owner, (trx, ctx) => hubConfig.draft(trx, ctx, hub, 'federation', { filler, nested: { deep: { limit: 2 } }, peers: [{ host: 'a.example.invalid', level: 'deal_routing' }] }));
    const request = await ask(p.officer, 'federation.raise_peering_level', configActivationDigestInput({ id: second.id, hubId: hub, domain: 'federation', version: second.version, payloadDigest: second.payload_digest }), false);
    const c = await change(p.owner, request.id);
    assert.deepEqual(field(c, 'nested.deep.limit'), { field: 'nested.deep.limit', before: { kind: 'text', value: '1' }, after: { kind: 'text', value: '2' } });
    assert.deepEqual(field(c, 'peers.0.level'), { field: 'peers.0.level', before: { kind: 'text', value: 'identity' }, after: { kind: 'text', value: 'deal_routing' } });
    assert.equal(field(c, 'filler'), undefined);
    assert.equal(c.complete, true);

    const third = await a.cmd(p.owner, (trx, ctx) => hubConfig.draft(trx, ctx, hub, 'federation', { filler: filler.repeat(10), nested: { deep: { limit: 2 } }, peers: [] }));
    const tooLong = await ask(p.officer, 'federation.raise_peering_level', configActivationDigestInput({ id: third.id, hubId: hub, domain: 'federation', version: third.version, payloadDigest: third.payload_digest }), false);
    const cut = await change(p.owner, tooLong.id);
    assert.equal(cut.complete, false, 'the answer says it is not whole');
    assert.deepEqual(field(cut, 'filler')?.after, { kind: 'key', key: 'approvals.tooLong' });
    await rejects(a.cmd(p.owner, (trx, ctx) => approvals.decide(trx, ctx, tooLong.id, 'approve', tooLong.action_digest)), '42501', 'admin.change_incomplete');
  });

  await t.test('a value that cannot be read leaves that one card incomplete: the list reads, and the other cards are whole', async () => {
    const federation = async (payload: Record<string, unknown>) => {
      const v = await a.cmd(p.owner, (trx, ctx) => hubConfig.draft(trx, ctx, hub, 'federation', payload));
      return ask(p.officer, 'federation.raise_peering_level', configActivationDigestInput({ id: v.id, hubId: hub, domain: 'federation', version: v.version, payloadDigest: v.payload_digest }), false);
    };
    const bad = [
      await federation({ retrySeconds: -1 }), await federation({ personId: 'x' }),
      await federation({ nested: { subjectPersonId: 7 } }), await federation({ 'key with space': 1 }),
    ];
    const good = await federation({ retrySeconds: 90, personId: p.outsider });
    const role = adminDigests.assignmentInput({ breakglass: false, personId: p.moderator, role: 'hub-owner', scope, definitionVersion: 1 });
    const other = await ask(p.founder, 'staff.assign_sensitive_role', role);
    const all = await a.as(p.owner, (trx) => approvals.changes(trx, [...bad.map((b) => b.id), good.id, other.id]));
    for (const b of bad) {
      const c = ApprovalChangeSchema.parse(all.get(b.id));
      assert.deepEqual([c.bound, c.complete], [true, false], JSON.stringify(c));
      await rejects(a.cmd(p.owner, (trx, ctx) => approvals.decide(trx, ctx, b.id, 'approve', b.action_digest)), '42501', 'admin.change_incomplete');
    }
    assert.deepEqual(field(ApprovalChangeSchema.parse(all.get(bad[0]!.id)), 'retrySeconds')?.after, { kind: 'key', key: 'approvals.unreadable' });
    assert.deepEqual(field(ApprovalChangeSchema.parse(all.get(bad[1]!.id)), 'personId')?.after, { kind: 'key', key: 'approvals.unreadable' });
    // A draft holds no fraction and nothing past 2^53, because the payload digest refuses them; the reading refuses them by itself all the same.
    await rejects(a.cmd(p.owner, (trx, ctx) => hubConfig.draft(trx, ctx, hub, 'federation', { retrySeconds: 1.5 })), '22023', 'validation.not_canonicalizable');
    const read = async (path: string, value: string) => withMaintenance(db.admin, async (trx) => (await sql<{ v: unknown }>`SELECT trustwork.admin_change_value('federation.raise_peering_level', ${path}, ${value}::jsonb) AS v`.execute(trx)).rows[0]!.v);
    for (const number of ['1.5', '1e30']) assert.deepEqual(await read('retrySeconds', number), { kind: 'unreadable' }, number);
    assert.deepEqual(await read('role', '"Not A Role"'), { kind: 'text', value: 'Not A Role' }, 'not a role key, so as stored');
    const whole = ApprovalChangeSchema.parse(all.get(good.id));
    assert.equal(whole.complete, true, JSON.stringify(whole));
    assert.deepEqual(field(whole, 'retrySeconds')?.after, { kind: 'duration', seconds: 90 });
    assert.equal((await change(p.founder2, other.id)).complete, true);
    // Declining clears it, so nothing stays stuck on the inbox.
    await a.cmd(p.owner, (trx, ctx) => approvals.decide(trx, ctx, bad[0]!.id, 'decline', bad[0]!.action_digest));
  });

  await t.test('a proved input the reading cannot follow is that card only, and proves nothing', async () => {
    const crafted = { action: 'egress.allow_private_class', connectionId: 'not-a-uuid', dataClass: 'person_private', version: 1 };
    const request = await ask(p.owner, 'egress.allow_private_class', crafted);
    const good = await ask(p.founder, 'staff.assign_sensitive_role', adminDigests.assignmentInput({ breakglass: false, personId: p.outsider, role: 'hub-owner', scope, definitionVersion: 1 }));
    const all = await a.as(p.founder2, (trx) => approvals.changes(trx, [request.id, good.id]));
    assert.equal(ApprovalChangeSchema.parse(all.get(good.id)).complete, true);
    const c = await change(p.officer, request.id);
    assert.deepEqual([c.bound, c.complete, c.fields], [false, false, []]);
    await rejects(a.cmd(p.officer, (trx, ctx) => approvals.decide(trx, ctx, request.id, 'approve', request.action_digest)), '42501', 'admin.change_unbound');
  });

  await t.test('a key with a dot is not a path: a move between the two shapes is not hidden', async () => {
    const federation = async (payload: Record<string, unknown>) => a.cmd(p.owner, (trx, ctx) => hubConfig.draft(trx, ctx, hub, 'federation', payload));
    const input = (v: { id: string; version: number; payload_digest: string }) => configActivationDigestInput({ id: v.id, hubId: hub, domain: 'federation', version: v.version, payloadDigest: v.payload_digest });
    const first = await federation({ limits: { max: 1 } });
    const asked = await ask(p.officer, 'federation.raise_peering_level', input(first), false);
    await a.cmd(p.owner, (trx, ctx) => approvals.decide(trx, ctx, asked.id, 'approve', asked.action_digest));
    await a.cmd(p.officer, (trx, ctx) => hubConfig.activate(trx, ctx, first.id, null, asked.id));
    const moved = await ask(p.officer, 'federation.raise_peering_level', input(await federation({ 'limits.max': 1 })), false);
    const c = await change(p.owner, moved.id);
    assert.equal(c.complete, false, 'the same dotted name, another shape: not a change the card can name');
    assert.deepEqual(field(c, 'limits.max')?.before, { kind: 'text', value: '1' }, 'and the leaf that went is listed');
    await rejects(a.cmd(p.owner, (trx, ctx) => approvals.decide(trx, ctx, moved.id, 'approve', moved.action_digest)), '42501', 'admin.change_incomplete');
  });

  await t.test('a person reads as more than a name: the identifier always, a masked address on a staff change, and a missing name keeps the card', async () => {
    const twinId = p.otherOwner;
    const name = async (personId: string, value: string | null) => withMaintenance(db.admin, (trx) => sql`UPDATE trustwork.person SET display_name = ${value} WHERE id = ${personId}::uuid`.execute(trx));
    const assign = (personId: string) => ask(p.founder, 'staff.assign_sensitive_role', adminDigests.assignmentInput({ breakglass: false, personId, role: 'compliance-officer', scope, definitionVersion: 1 }));
    await name(twinId, 'Synthetic moderator');
    await name(p.moderator, 'Synthetic moderator');
    const forTwin = await assign(twinId);
    const forOriginal = await assign(p.moderator);
    type Shown = { displayName: string | null; personId: string; maskedEmail: string | null };
    const person = async (id: string) => field(await change(p.founder2, id), 'personId')?.after as Shown;
    const [twin, original] = [await person(forTwin.id), await person(forOriginal.id)];
    assert.deepEqual([twin.displayName, original.displayName], ['Synthetic moderator', 'Synthetic moderator']);
    assert.deepEqual([twin.personId, original.personId], [twinId, p.moderator], 'one name, two identifiers');
    await withMaintenance(db.admin, async (trx) => {
      await sql`DELETE FROM trustwork.email_binding WHERE person_id = ${twinId}::uuid`.execute(trx);
      await sql`INSERT INTO trustwork.email_binding (person_id, email_normalized, is_primary, verified_at) VALUES (${twinId}::uuid, 'synthetic.twin@example.invalid', true, now())`.execute(trx);
    });
    const masked = await person(forTwin.id);
    assert.equal(masked.maskedEmail, 'sy***@example.invalid', 'masked, as the support workspace shows it');
    await withMaintenance(db.admin, (trx) => sql`UPDATE trustwork.email_binding SET verified_at = NULL WHERE person_id = ${twinId}::uuid`.execute(trx));
    assert.equal((await person(forTwin.id)).maskedEmail, null, 'only a verified address');
    await name(twinId, null);
    const nameless = await change(p.founder2, forTwin.id);
    assert.equal(nameless.complete, true);
    assert.deepEqual(field(nameless, 'personId')?.after, { kind: 'person', personId: twinId, displayName: null, maskedEmail: null });
    await name(twinId, 'Synthetic other owner');
    await name(p.moderator, 'Synthetic moderator');
  });

  await t.test('an action nothing maps has no readers: no hub reader sees it, and nobody approves it', async () => {
    const readers = await withMaintenance(db.admin, async (trx) => (await sql<{ m: string[] }>`SELECT trustwork.admin_change_read_permissions('synthetic.unmapped', ${hub}::uuid) AS m`.execute(trx)).rows[0]!.m);
    assert.deepEqual(readers, []);
  });

  await t.test('private detail has readers: a staff reader and an audit reader get the action, scope and digest, and whoever cannot read it cannot approve it', async () => {
    const hidden = { bound: false, visible: false, complete: false, current: false, currentDigest: null, fields: [], apply: null };
    await withMaintenance(db.admin, async (trx) => {
      await staffRoleDefinitions.release(trx, { version: 2, role: 'moderator', scopes: ['hub'], permissions: ['admin.moderation.read', 'admin.moderation.decide'], caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
      await staffRoleDefinitions.release(trx, { version: 2, role: 'support-agent', scopes: ['hub'], permissions: ['admin.moderation.decide'], caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
    });
    for (const [personId, role] of [[p.moderator, 'moderator'], [p.otherOwner, 'support-agent']] as const) await a.cmd(p.founder, (trx, ctx) => staffAssignments.assign(trx, ctx, { personId, role, scope, definitionVersion: 2 }));
    // A sanction's subject is not a staff change: no address, even a verified one.
    await withMaintenance(db.admin, async (trx) => {
      await sql`DELETE FROM trustwork.email_binding WHERE person_id = ${p.outsider}::uuid`.execute(trx);
      await sql`INSERT INTO trustwork.email_binding (person_id, email_normalized, is_primary, verified_at) VALUES (${p.outsider}::uuid, 'synthetic.subject@example.invalid', true, now())`.execute(trx);
    });
    const input = adminDigests.sanctionInput({ moderationCaseId: randomUUID(), subject: { kind: 'person', id: p.outsider }, level: 4, featureScope: 'account', durationSeconds: null });
    const request = await ask(p.moderator, 'moderation.apply_sanction_l4', input);
    const shown = await change(p.moderator, request.id);
    assert.deepEqual(field(shown, 'sanctionSubject')?.after, { kind: 'person', personId: p.outsider, displayName: 'Synthetic outsider', maskedEmail: null });
    assert.equal(shown.current, false, 'the case is not there');
    await assertCardBinds(db.admin, request.id);
    // p.founder2 reads staff, p.officer reads the audit: neither reads moderation.
    for (const reader of [p.founder2, p.officer]) assert.deepEqual(await change(reader, request.id), hidden, 'only the action, scope and digest');
    const rows = (who: string) => a.as(who, (trx) => trx.selectFrom('second_person_approval_subject').select('subject').where('approval_id', '=', request.id).execute());
    assert.deepEqual(await rows(p.founder2), [], 'and not through the digest input either');
    // Executes the action, but cannot read the case: cannot approve what it cannot see.
    assert.deepEqual(await change(p.otherOwner, request.id), hidden);
    await rejects(a.cmd(p.otherOwner, (trx, ctx) => approvals.decide(trx, ctx, request.id, 'approve', request.action_digest)), '42501', 'admin.change_hidden');
  });

  await t.test('a digest nothing proves is `bound: false`; nothing is guessed', async () => {
    const request = await a.cmd(p.owner, (trx, ctx) => approvals.request(trx, ctx, { action: 'hub.change_residency', scope, actionDigest: randomBytes(32).toString('hex') }));
    assert.deepEqual(await change(p.officer, request.id), { bound: false, visible: true, complete: false, current: false, currentDigest: null, fields: [], apply: null });
    // The console refuses it, and so does the database, whoever asks.
    await rejects(a.cmd(p.officer, (trx, ctx) => approvals.decide(trx, ctx, request.id, 'approve', request.action_digest)), '42501', 'admin.change_unbound');
    assert.equal((await a.cmd(p.officer, (trx, ctx) => approvals.decide(trx, ctx, request.id, 'decline', request.action_digest))).status, 'declined', 'declining needs no proof');
    for (const action of ['automation.raise_to_supervised_autonomous', 'billing.release_payout_batch', 'staff.switch_sod_mode']) {
      const none = await a.cmd(p.owner, (trx, ctx) => approvals.request(trx, ctx, { action, scope, actionDigest: randomBytes(32).toString('hex') })).catch(() => null);
      if (none) assert.equal((await change(p.owner, none.id)).bound, false, action);
    }
  });

  await t.test('negative: a digest input must hash to the digest, and only the requester of an open request records one', async () => {
    const real = adminDigests.assignmentInput({ breakglass: false, personId: p.outsider, role: 'moderator', scope, definitionVersion: 1 });
    const forged = adminDigests.assignmentInput({ breakglass: false, personId: p.outsider, role: 'hub-owner', scope, definitionVersion: 1 });
    const request = await a.cmd(p.founder, (trx, ctx) => approvals.request(trx, ctx, { action: 'staff.assign_sensitive_role', scope, actionDigest: computeDigest(real).value }));
    const bind = (by: string, input: unknown) => a.as(by, (trx) => sql`SELECT trustwork.admin_bind_approval_subject(${request.id}::uuid, ${JSON.stringify(input)}::jsonb)`.execute(trx));
    await rejects(bind(p.founder, forged), '23514', 'admin.approval_mismatch');
    await rejects(bind(p.founder2, real), 'P0002', 'admin.not_found');
    assert.equal((await change(p.founder2, request.id)).bound, false);
    await bind(p.founder, real);
    assert.deepEqual(field(await change(p.founder2, request.id), 'role')?.after, { kind: 'key', key: 'roles.moderator' });
    await rejects(withMaintenance(db.admin, (trx) => trx.updateTable('second_person_approval_subject').set({ subject: JSON.stringify(forged) as never }).where('approval_id', '=', request.id).execute()), '23000');
    await rejects(bind(p.founder, real), '23505');
  });

  await t.test('negative: only the approval\'s own readers read its change', async () => {
    const request = await ask(p.founder, 'staff.assign_sensitive_role', adminDigests.assignmentInput({ breakglass: false, personId: p.outsider, role: 'hub-owner', scope, definitionVersion: 1, validForSeconds: 3600 }));
    for (const person of [p.outsider, p.moderator, p.otherOwner]) assert.equal((await a.as(person, (trx) => approvals.changes(trx, [request.id]))).get(request.id), null);
    assert.equal((await change(p.founder, request.id)).bound, true, 'the requester reads it');
    const subjects = (person: string) => a.as(person, (trx) => trx.selectFrom('second_person_approval_subject').select('approval_id').where('approval_id', '=', request.id).execute());
    assert.deepEqual(await subjects(p.outsider), [], 'the digest input has the approval\'s readers, and no others');
    assert.equal((await subjects(p.founder)).length, 1);
  });
});
