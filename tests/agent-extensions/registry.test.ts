import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import { withMaintenance, withPrincipal } from '@trustwork/data';
import { ConsoleCommandResultSchema } from '@trustwork/contracts';
import { SideEffectSchema } from '../../packages/contracts/src/agent-catalog.js';
import { CORE_AGENT_MANIFEST } from '../../packages/contracts/src/agents.js';
import { EXTENSION_MANIFEST_KEYS, PRIVATE_CLASS_EGRESS, SIDE_EFFECT_MANDATE_KINDS } from '../../packages/contracts/src/agent-extensions.js';
import { agentExtensions, agentExtensionWorker } from '../../packages/data/src/repositories/agent-extensions.js';
import { hubConfig } from '../../packages/data/src/repositories/hubs.js';
import { inTransaction } from '@trustwork/worker';
import { FakeExtensionAdapter } from '../../apps/worker/src/agent-extensions/index.js';
import { Client, SKIP_REASON, startHarness } from '../backend/helpers/app.js';
import { login, seedPersonas } from '../backend/helpers/personas.js';
import { expectRefusal } from '../admin/helpers.js';
import { principalFor } from '../data/helpers/seed.js';
import { rejects } from '../hubs/helpers.js';
import { command, ok } from '../agent-modules/helpers.js';
import {
  activateRoute, activateVersion, allowEgress, buildExtensionWorld, draftVersion, ENGINE, lookup, manifestOf, testedVersion, uniqueKey, viewOf, type ActivationBody, type CommandBody, type ExtensionWorld,
} from './helpers.js';

/**
 * AGT-023 through the HTTP API on real PostgreSQL under the runtime role and the worker role: registration refusals at the
 * API and again in the database, the lifecycle, suites that only the worker can record, and activation as a hub
 * configuration version under a second person, with every activation precondition refused on its own.
 */
const h = await startHarness('agent_extensions_registry');

test('governed extension registry: registration, lifecycle, safety suites and second-person activation', { skip: h ? false : SKIP_REASON, timeout: 300_000 }, async (t) => {
  if (!h) return;
  const x: ExtensionWorld = await buildExtensionWorld(h);
  t.after(async () => { await x.close(); await h.close(); });
  const { base, staff, a, w, hubId } = x;
  const admin = h.db.admin;
  await seedPersonas(h);
  const petr = h.client();
  await login(petr, 'petr');
  const draftInDb = (manifest: unknown) => a.cmd(w.people.owner, (trx, ctx) => agentExtensions.draft(trx, ctx, hubId, manifest));

  await t.test('the database lists exactly the contract vocabulary', async () => {
    const { rows } = await admin.query<{ k: string[] }>('SELECT trustwork.agent_extensions_manifest_keys() AS k');
    assert.deepEqual(rows[0]!.k, [...EXTENSION_MANIFEST_KEYS]);
    for (const effect of SideEffectSchema.options) {
      const r = await admin.query<{ k: string[] | null }>('SELECT trustwork.agent_extensions_side_effect_kinds($1) AS k', [effect]);
      assert.deepEqual(r.rows[0]!.k, SIDE_EFFECT_MANDATE_KINDS[effect] ?? null, effect);
    }
    for (const [name, classes] of Object.entries(PRIVATE_CLASS_EGRESS)) {
      const r = await admin.query<{ k: string[] }>('SELECT trustwork.agent_extensions_private_class_egress($1) AS k', [name]);
      assert.deepEqual(r.rows[0]!.k, [...classes], name);
    }
  });

  await t.test('negative: anonymous, participants and staff without extension permissions never reach the registry', async () => {
    const manifest = manifestOf(uniqueKey('denied'));
    expectRefusal(await new Client(h.created).get(base), 401, 'auth.session_invalid');
    expectRefusal(await petr.get(base), 403, 'access.forbidden', 'staff');
    expectRefusal(await command(petr, `${base}/versions`, { manifest }), 403, 'access.forbidden', 'staff');
    expectRefusal(await staff.moderator.get(base), 404, 'access.not_found');
    expectRefusal(await command(staff.moderator, `${base}/versions`, { manifest }), 403, 'access.forbidden');
    expectRefusal(await command(staff.moderator, `${base}/versions`, { manifest: { skipMandates: true } }), 403, 'access.forbidden', undefined);
    assert.equal((await admin.query('SELECT 1 FROM trustwork.agent_extension')).rowCount, 0);
  });

  await t.test('ACCEPTANCE: a manifest with an action without a mandate kind is refused, at the API and in the database', async () => {
    const withoutKind = Object.fromEntries(Object.entries(lookup).filter(([k]) => k !== 'mandateKind'));
    const manifest = { ...manifestOf(uniqueKey('nokind')), actions: [withoutKind] };
    expectRefusal(await command(staff.owner, `${base}/versions`, { manifest }), 422, 'validation.schema', 'action_without_mandate_kind');
    await rejects(draftInDb(manifest), '23514', 'agents.action_without_mandate_kind');
    await rejects(draftInDb({ ...manifest, actions: [{ ...lookup, mandateKind: 'whatever' }] }), '23514', 'agents.action_without_mandate_kind');
  });

  await t.test('a declared side effect fixes the mandate kind: research that sends a message is refused, at the API and in the database', async () => {
    const outbound = manifestOf(uniqueKey('outbound'), { actions: [{ ...lookup, sideEffects: ['external_call', 'outbound_message'] }] });
    expectRefusal(await command(staff.owner, `${base}/versions`, { manifest: outbound }), 422, 'validation.schema', 'side_effect_needs_mandate_kind');
    await rejects(draftInDb(outbound), '23514', 'agents.side_effect_needs_mandate_kind');
    const publishing = manifestOf(uniqueKey('publishing'), { actions: [{ ...lookup, sideEffects: ['external_call', 'publication'] }] });
    await rejects(draftInDb(publishing), '23514', 'agents.side_effect_needs_mandate_kind');
    // Under its own kind it meets that kind's floor: a person each time, as the strongest built-in `communicate` asks.
    const asCommunicate = { ...lookup, mandateKind: 'communicate' as const, sideEffects: ['external_call' as const, 'outbound_message' as const] };
    const weak = manifestOf(uniqueKey('weak'), { actions: [asCommunicate], requiredMandateKinds: ['communicate'] });
    expectRefusal(await command(staff.owner, `${base}/versions`, { manifest: weak }), 422, 'validation.schema', 'confirmation_below_built_in');
    await draftVersion(x, manifestOf(uniqueKey('person'), { actions: [{ ...asCommunicate, confirmation: 'person_each' }], requiredMandateKinds: ['communicate'] }));
  });

  await t.test('what leaves is declared: an external call without classes, or a private class not sent, is refused', async () => {
    const silent = manifestOf(uniqueKey('silent'), { actions: [{ ...lookup, dataClassesSent: [] }] });
    expectRefusal(await command(staff.owner, `${base}/versions`, { manifest: silent }), 422, 'validation.schema', 'data_classes_undeclared');
    await rejects(draftInDb(silent), '23514', 'agents.data_classes_undeclared');
    const budgets = { ...lookup, privateDataClasses: ['budgets' as const], kind: 'draft' as const, mandateKind: 'prepare' as const, confirmation: 'none' as const, sideEffects: ['external_call' as const] };
    const hidden = manifestOf(uniqueKey('hidden'), { actions: [budgets], requiredMandateKinds: ['prepare'] });
    expectRefusal(await command(staff.owner, `${base}/versions`, { manifest: hidden }), 422, 'validation.schema', 'private_class_not_sent');
    await rejects(draftInDb(hidden), '23514', 'agents.private_class_not_sent');
    // Declared honestly it registers, and a public-only route then refuses it at activation.
    const declared = await testedVersion(x, manifestOf(uniqueKey('declared'), { actions: [{ ...budgets, dataClassesRead: ['company_private'], dataClassesSent: ['company_private'] }], requiredMandateKinds: ['prepare'] }));
    assert.equal(declared.ref.status, 'tested');
    await activateRoute(x, declared.ref.extensionId, ['public']);
    const refusal = await command(staff.officer, `${base}/activations`, { versionIds: [declared.ref.id] });
    expectRefusal(refusal, 422, 'validation.schema', 'egress_denied');
    assert.match(JSON.stringify((refusal.body as { details: { items: string[] } }).details.items), /data_class_not_in_route:company_private/);
  });

  await t.test('ACCEPTANCE: a guard-rail override or a weaker confirmation is refused, at the API and in the database', async () => {
    const key = uniqueKey('guard');
    for (const manifest of [{ ...manifestOf(key), skipMandates: true }, { ...manifestOf(key), sanctionsGate: 'off' }, { ...manifestOf(key), actions: [{ ...lookup, paymentNeutrality: false }] }]) {
      expectRefusal(await command(staff.owner, `${base}/versions`, { manifest }), 422, 'validation.schema', 'guard_rail');
      await rejects(draftInDb(manifest), '23514', 'agents.guard_rail');
    }
    const order = { ...lookup, mandateKind: 'place_order' as const, sideEffects: ['external_call' as const, 'money_commitment' as const], confirmation: 'mandate' as const };
    const weaker = manifestOf(key, { actions: [order], requiredMandateKinds: ['place_order'] });
    expectRefusal(await command(staff.owner, `${base}/versions`, { manifest: weaker }), 422, 'validation.schema', 'confirmation_below_built_in');
    await rejects(draftInDb(weaker), '23514', 'agents.confirmation_below_built_in');
    await rejects(draftInDb({ ...manifestOf(key), actions: [{ ...lookup, kind: 'read' }] }), '23514', 'agents.action_kind_refused');
    await rejects(draftInDb({ ...manifestOf(key), actions: [{ ...lookup, acceptsUntrustedText: true }] }), '23514', 'agents.manifest_invalid');
    const engineKey = manifestOf('core', { safetySuite: { suiteId: 'extension.core' } });
    expectRefusal(await command(staff.owner, `${base}/versions`, { manifest: engineKey }), 422, 'validation.schema', 'key_reserved');
    await rejects(draftInDb(engineKey), '23514', 'agents.key_reserved');
  });

  await t.test('ACCEPTANCE: an endpoint in a restricted place cannot be registered, by country, region or domain', async () => {
    const key = uniqueKey('place');
    const at = (country: string, region: string | null, host = 'permits.synthetic.example') => manifestOf(key, { endpoints: [{ host, country, region }], actions: [{ ...lookup, endpointHosts: [host] }] });
    for (const manifest of [at('IR', null), at('UA', 'UA-43'), at('US', null, 'permits.synthetic.ru')]) {
      expectRefusal(await command(staff.owner, `${base}/versions`, { manifest }), 422, 'validation.schema', 'restricted_endpoint');
      await rejects(draftInDb(manifest), '23514', 'agents.restricted_endpoint');
    }
    assert.equal((await admin.query('SELECT 1 FROM trustwork.agent_extension WHERE key = $1', [key])).rowCount, 0);
  });

  await t.test('a run is asked for, never stated: only the worker role records it, under a live lease', async () => {
    const drafted = await draftVersion(x, manifestOf(uniqueKey('suite')));
    assert.equal(drafted.ref.status, 'draft');
    assert.equal(drafted.ref.safetySuite, null);
    assert.equal(drafted.ref.manifestDigest.value.length, 64);
    const run = ok<CommandBody & { run: { id: string; state: string } }>(await command(staff.owner, `${base}/versions/${drafted.ref.id}/safety-runs`, { expectedRevision: drafted.revision }), 201);
    assert.equal(run.run.state, 'requested');
    assert.equal((await viewOf(x, drafted.ref.id)).ref.status, 'draft', 'asking changes nothing');
    expectRefusal(await command(staff.owner, `${base}/versions/${drafted.ref.id}/safety-runs`, { expectedRevision: drafted.revision }), 409, 'validation.revision_conflict', 'suite_pending');
    const report = { schema: 'trustwork.agent-safety-report/1', suiteId: 'x', engineVersion: ENGINE, onFakeAdapter: true, manifestDigest: drafted.ref.manifestDigest.value, scenarios: [{ id: 'x', status: 'passed' }], passed: true };
    const job = (await admin.query<{ id: string; fencing_token: string }>("SELECT id, fencing_token FROM trustwork.job WHERE kind = 'agents.extension_safety_run' AND payload ->> 'runId' = $1", [run.run.id])).rows[0]!;
    // The runtime role has no such function, and no staff route exists: staff cannot pass a suite.
    await rejects(withPrincipal(h.pool, await principalFor(admin, w.people.owner), (trx) => agentExtensionWorker.recordRun(trx, run.run.id, job.id, job.fencing_token, report)), '42501');
    await rejects(withPrincipal(h.pool, await principalFor(admin, w.people.owner), (trx) => sql`UPDATE trustwork.agent_extension_version SET status = 'tested' WHERE id = ${drafted.ref.id}::uuid`.execute(trx)), '42501');
    await rejects(withPrincipal(h.pool, await principalFor(admin, w.people.owner), (trx) => sql`INSERT INTO trustwork.agent_extension_safety_run (hub_id, version_id, manifest_digest, trigger, requested_by) VALUES (${hubId}::uuid, ${drafted.ref.id}::uuid, ${'a'.repeat(64)}, 'staff', ${w.people.owner}::uuid)`.execute(trx)), '42501');
    // The worker role without a live lease is refused too; the payload alone proves nothing.
    await rejects(inTransaction(x.runtime.pool, (trx) => agentExtensionWorker.recordRun(trx, run.run.id, job.id, job.fencing_token, report)), '55P03', 'agents.fenced_out');
    await x.drain();
    const tested = await viewOf(x, drafted.ref.id);
    assert.equal(tested.ref.status, 'tested');
    assert.equal(tested.ref.safetySuite?.passed, true);
    assert.equal(tested.ref.safetySuite?.engineVersion, ENGINE);
    assert.equal(tested.latestRun?.state, 'passed');
    assert.ok((tested.latestRun as unknown as { scenarioCount: number }).scenarioCount >= 8, 'the suite covers the manifest and each action');
  });

  await t.test('a suite that fails, or an adapter the engine does not have, leaves the version a draft', async () => {
    const unknownAdapter = await testedVersion(x, manifestOf(uniqueKey('noadapter'), { adapter: { adapterId: 'not_installed', fakeAdapterId: 'not_installed_fake' } }));
    assert.equal(unknownAdapter.ref.status, 'draft');
    assert.equal(unknownAdapter.latestRun?.state, 'failed');
    const previous = x.runtime.adapters;
    x.installAdapters([{ adapterId: 'synthetic_http', fakeAdapterId: 'synthetic_http_fake', live: null, fake: new FakeExtensionAdapter('synthetic_http_fake', () => ({ summary: 'done', facts: {}, toolCalls: [{ kind: 'propose_action' }] })) }]);
    const commanding = await testedVersion(x, manifestOf(uniqueKey('commanding')));
    x.installAdapters(previous);
    assert.equal(commanding.ref.status, 'draft', 'an adapter that answers with a tool call never passes');
    assert.ok((commanding.latestRun?.failedCount ?? 0) >= 1);
    expectRefusal(await command(staff.officer, `${base}/activations`, { versionIds: [commanding.ref.id] }), 422, 'validation.schema', 'version_not_ready');
  });

  await t.test('activation refuses a missing route, a route the egress matrix denies and, until billing can confirm a price, any charge', async () => {
    const noRoute = await testedVersion(x, manifestOf(uniqueKey('noroute')));
    expectRefusal(await command(staff.officer, `${base}/activations`, { versionIds: [noRoute.ref.id] }), 422, 'validation.schema', 'route_missing');

    const sending = { ...lookup, dataClassesRead: ['person_private' as const], dataClassesSent: ['person_private' as const] };
    const notInRoute = await testedVersion(x, manifestOf(uniqueKey('notinroute'), { actions: [sending] }));
    await activateRoute(x, notInRoute.ref.extensionId, ['public']);
    expectRefusal(await command(staff.officer, `${base}/activations`, { versionIds: [notInRoute.ref.id] }), 422, 'validation.schema', 'egress_denied');

    // ACCEPTANCE: the route admits the class, the egress matrix has no cell for it: default deny.
    const denied = await testedVersion(x, manifestOf(uniqueKey('denied'), { actions: [sending] }));
    await activateRoute(x, denied.ref.extensionId, ['public', 'person_private']);
    const refusal = await command(staff.officer, `${base}/activations`, { versionIds: [denied.ref.id] });
    expectRefusal(refusal, 422, 'validation.schema', 'egress_denied');
    assert.deepEqual((refusal.body as { details: { items: string[] } }).details.items, ['egress_denied:no_rule']);
    // The refusal is that cell and nothing else: a second person allows it, and the same version can be proposed.
    await allowEgress(x, 'person_private');
    ok(await command(staff.officer, `${base}/activations`, { versionIds: [denied.ref.id] }), 201);

    const report = {
      ...lookup, operation: 'order_report', mandateKind: 'generate_deliverable' as const,
      cost: { kind: 'per_call' as const, amount: { minorUnits: '250', currency: 'USD' }, meter: 'external_calls' as const, priceVersionId: '00000000-0000-4000-8000-0000000000f1' },
    };
    const charged = await testedVersion(x, manifestOf(uniqueKey('charged'), { actions: [report], requiredMandateKinds: ['generate_deliverable'] }));
    await activateRoute(x, charged.ref.extensionId);
    expectRefusal(await command(staff.officer, `${base}/activations`, { versionIds: [charged.ref.id] }), 422, 'validation.schema', 'price_version_unavailable');
  });

  await t.test('ACCEPTANCE: activation by the drafter alone fails, and the drafter never counts as the second person', async () => {
    const v = await testedVersion(x, manifestOf(uniqueKey('alone')));
    await activateRoute(x, v.ref.extensionId);
    const proposed = ok<ActivationBody>(await command(staff.owner, `${base}/activations`, { versionIds: [v.ref.id] }), 201).activation;
    assert.equal(proposed.activation.secondPersonAction, 'agents.activate_extension');
    const url = `${base}/activations/${proposed.configVersionId}/activate`;
    // The drafter asks for itself: refused before any approval exists.
    expectRefusal(await command(staff.owner, url, { expectedRevision: proposed.revision, approvalId: null }), 403, 'access.second_approver_required', 'self_approval');
    // Without any approval the activation stays closed, whoever calls.
    await rejects(a.cmd(w.people.officer, (trx, ctx) => hubConfig.activate(trx, ctx, proposed.configVersionId, proposed.revision, null)), '42501', 'admin.approval_required');
    // Another person asks, and the drafter of the manifest approves: still one reviewer short.
    const pending = ok<CommandBody>(await command(staff.officer, url, { expectedRevision: proposed.revision, approvalId: null }));
    const approvalId = pending.result.approvalRequestId as string;
    expectRefusal(await command(staff.officer, `/v1/admin/approvals/${approvalId}/approve`, { actionDigest: proposed.activation.actionDigest }), 403, 'access.second_approver_required', 'self_approval');
    ok(await command(staff.owner, `/v1/admin/approvals/${approvalId}/approve`, { actionDigest: proposed.activation.actionDigest }));
    expectRefusal(await command(staff.officer, url, { expectedRevision: proposed.revision, approvalId }), 403, 'access.second_approver_required', 'drafter_cannot_approve');
    assert.equal((await viewOf(x, v.ref.id)).ref.status, 'tested', 'nothing moved');
    assert.equal((await admin.query("SELECT status FROM trustwork.hub_config_version WHERE id = $1", [proposed.configVersionId])).rows[0].status, 'draft');
  });

  await t.test('a reviewed activation is a hub configuration version; the version is active and audited', async () => {
    const v = await testedVersion(x, manifestOf(uniqueKey('live')));
    await activateRoute(x, v.ref.extensionId);
    const applied = ok<CommandBody>(await activateVersion(x, [v.ref.id]));
    ConsoleCommandResultSchema.parse(applied.result);
    assert.equal(applied.result.outcome, 'applied');
    const active = await viewOf(x, v.ref.id);
    assert.equal(active.ref.status, 'active');
    assert.equal(active.ref.approvedBy, w.people.officer);
    assert.equal(active.ref.activatedConfigVersionId, applied.result.objectId);
    const current = (await admin.query<{ domain: string; status: string; payload: { activeVersions: { versionId: string }[] } }>('SELECT domain, status, payload FROM trustwork.hub_config_version WHERE id = $1', [applied.result.objectId])).rows[0]!;
    assert.equal(current.domain, 'agent_extensions');
    assert.equal(current.status, 'active');
    assert.ok(current.payload.activeVersions.some((e) => e.versionId === v.ref.id));
    const audit = await admin.query("SELECT 1 FROM trustwork.admin_audit_event WHERE action = 'hub.config_activated' AND object_id = $1", [applied.result.objectId]);
    assert.equal(audit.rowCount, 1);
    const history = ok<{ transitions: { from: string; to: string; by: string }[] }>(await staff.officer.get(`${base}/versions/${v.ref.id}`)).transitions;
    assert.deepEqual(history.map((e) => [e.from, e.to, e.by]), [['draft', 'tested', 'engine'], ['tested', 'active', 'staff']]);
    // A participant sees what the hub offers and nothing of how it got there.
    const asPetr = await withPrincipal(h.pool, await principalFor(admin, (await admin.query<{ person_id: string }>("SELECT person_id FROM trustwork.session WHERE person_id NOT IN (SELECT person_id FROM trustwork.staff_role_assignment) LIMIT 1")).rows[0]!.person_id), async (trx) => ({
      active: await agentExtensions.active(trx, hubId), runs: await agentExtensions.runs(trx, hubId), transitions: await agentExtensions.transitions(trx, v.ref.id),
    }));
    assert.ok(asPetr.active.some((r) => r.id === v.ref.id));
    assert.deepEqual([asPetr.runs.length, asPetr.transitions.length], [0, 0]);
    assert.deepEqual(asPetr.active.filter((r) => r.status !== 'active'), []);
  });

  await t.test('a new version replaces the old one through the same second person; the old one retires', async () => {
    const key = uniqueKey('upgrade');
    const first = await testedVersion(x, manifestOf(key));
    await activateRoute(x, first.ref.extensionId);
    ok(await activateVersion(x, [first.ref.id]));
    const second = await testedVersion(x, manifestOf(key, { title: { en: 'Synthetic permit lookup, second edition' } }));
    assert.equal(second.ref.version, 2);
    assert.equal(second.ref.extensionId, first.ref.extensionId);
    ok(await activateVersion(x, [second.ref.id]));
    assert.equal((await viewOf(x, first.ref.id)).ref.status, 'retired');
    assert.equal((await viewOf(x, second.ref.id)).ref.status, 'active');
    assert.equal((await admin.query("SELECT 1 FROM trustwork.agent_extension_version WHERE extension_id = $1 AND status = 'active'", [first.ref.extensionId])).rowCount, 1);
  });

  await t.test('suspension is one person and immediate; coming back needs a new suite and a new second person', async () => {
    const v = await testedVersion(x, manifestOf(uniqueKey('suspend')));
    await activateRoute(x, v.ref.extensionId);
    ok(await activateVersion(x, [v.ref.id]));
    const active = await viewOf(x, v.ref.id);
    expectRefusal(await command(staff.moderator, `${base}/versions/${v.ref.id}/suspend`, { expectedRevision: active.revision }), 403, 'access.forbidden');
    expectRefusal(await command(staff.owner, `${base}/versions/${v.ref.id}/suspend`, { expectedRevision: active.revision + 1 }), 409, 'validation.revision_conflict', 'revision_conflict');
    ok(await command(staff.owner, `${base}/versions/${v.ref.id}/suspend`, { expectedRevision: active.revision }));
    const suspended = await viewOf(x, v.ref.id);
    assert.equal(suspended.ref.status, 'suspended');
    expectRefusal(await command(staff.owner, `${base}/versions/${v.ref.id}/suspend`, { expectedRevision: suspended.revision }), 409, 'validation.revision_conflict', 'invalid_transition');
    expectRefusal(await command(staff.officer, `${base}/activations`, { versionIds: [v.ref.id] }), 422, 'validation.schema', 'version_not_ready');
    ok(await command(staff.owner, `${base}/versions/${v.ref.id}/safety-runs`, { expectedRevision: suspended.revision }), 201);
    await x.drain();
    assert.equal((await viewOf(x, v.ref.id)).ref.status, 'tested');
    ok(await activateVersion(x, [v.ref.id]));
    assert.equal((await viewOf(x, v.ref.id)).ref.status, 'active');
    const again = await viewOf(x, v.ref.id);
    ok(await command(staff.owner, `${base}/versions/${v.ref.id}/retire`, { expectedRevision: again.revision }));
    const retired = await viewOf(x, v.ref.id);
    assert.equal(retired.ref.status, 'retired');
    expectRefusal(await command(staff.owner, `${base}/versions/${v.ref.id}/safety-runs`, { expectedRevision: retired.revision }), 409, 'validation.revision_conflict', 'invalid_transition');
    expectRefusal(await command(staff.owner, `${base}/versions/${v.ref.id}/retire`, { expectedRevision: retired.revision }), 409, 'validation.revision_conflict', 'invalid_transition');
  });

  await t.test('ACCEPTANCE: a suite that fails after an engine update suspends the active version, by the engine', async () => {
    const v = await testedVersion(x, manifestOf(uniqueKey('update')));
    await activateRoute(x, v.ref.extensionId);
    ok(await activateVersion(x, [v.ref.id]));
    assert.equal(await inTransaction(x.runtime.pool, (trx) => agentExtensionWorker.engineTick(trx, ENGINE)), 0, 'nothing to do on the same engine');
    const previous = x.runtime.adapters;
    const before = x.runtime.engineVersion;
    x.runtime.engineVersion = '0.2.0';
    x.installAdapters([]);
    const asked = await inTransaction(x.runtime.pool, (trx) => agentExtensionWorker.engineTick(trx, '0.2.0'));
    assert.ok(asked >= 1);
    assert.equal(await inTransaction(x.runtime.pool, (trx) => agentExtensionWorker.engineTick(trx, '0.2.0')), 0, 'one open run per version');
    await x.drain();
    x.installAdapters(previous);
    const suspended = await viewOf(x, v.ref.id);
    assert.equal(suspended.ref.status, 'suspended');
    assert.match(suspended.statusReason ?? '', /safety suite failed on engine 0\.2\.0/);
    const history = ok<{ transitions: { to: string; by: string }[] }>(await staff.owner.get(`${base}/versions/${v.ref.id}`)).transitions;
    assert.deepEqual(history.at(-1), { ...history.at(-1), to: 'suspended', by: 'engine' });
    // Back on a working engine: a pass returns it to tested; only a new second person makes it active again.
    ok(await command(staff.owner, `${base}/versions/${v.ref.id}/safety-runs`, { expectedRevision: suspended.revision }), 201);
    await x.drain();
    assert.equal((await viewOf(x, v.ref.id)).ref.status, 'tested');
    // The suite passed on 0.2.0 and the engine moves on: activation refuses a stale suite until the tick has re-run it.
    await inTransaction(x.runtime.pool, (trx) => agentExtensionWorker.engineTick(trx, before));
    x.runtime.engineVersion = before;
    expectRefusal(await command(staff.officer, `${base}/activations`, { versionIds: [v.ref.id] }), 422, 'validation.schema', 'suite_stale');
    await x.drain();
    ok(await activateVersion(x, [v.ref.id]));
  });

  await t.test('an engine that raises a built-in confirmation withdraws what is active below it, with or without a new engine number', async () => {
    // `maintain_records` has no built-in yet, so raising it here touches nothing else in this suite.
    const records = { ...lookup, mandateKind: 'maintain_records' as const };
    const v = await testedVersion(x, manifestOf(uniqueKey('floor'), { actions: [records], requiredMandateKinds: ['maintain_records'] }));
    await activateRoute(x, v.ref.extensionId);
    ok(await activateVersion(x, [v.ref.id]));
    const other = await testedVersion(x, manifestOf(uniqueKey('unaffected')));
    await activateRoute(x, other.ref.extensionId);
    ok(await activateVersion(x, [other.ref.id]));
    const capability = { ...CORE_AGENT_MANIFEST.capabilities.find((c) => c.kind === 'commit')!, id: 'synthetic_floor.keep_records', source: { kind: 'module', moduleKey: 'synthetic_floor', moduleVersion: '1.0.0' }, mandateAction: 'maintain_records', confirmation: 'person_each' };
    const document = { key: 'synthetic_floor', version: '1.0.0', actions: ['maintain_records'], capabilities: [capability] };
    await withMaintenance(admin, (trx) => sql`INSERT INTO trustwork.agent_engine_manifest (module_key, module_version, document, default_control) VALUES ('synthetic_floor', '1.0.0', ${JSON.stringify(document)}::jsonb, '{}'::jsonb)`.execute(trx));

    await inTransaction(x.runtime.pool, (trx) => agentExtensionWorker.engineTick(trx, ENGINE));
    const withdrawn = await viewOf(x, v.ref.id);
    assert.equal(withdrawn.ref.status, 'suspended', 'no suite and no new engine number were needed');
    assert.match(withdrawn.statusReason ?? '', /agents\.confirmation_below_built_in/);
    assert.equal((await viewOf(x, other.ref.id)).ref.status, 'active', 'a version the rule does not touch stays');

    // Even a run the worker reports as passed cannot bring it back.
    const run = ok<{ run: { id: string } }>(await command(staff.owner, `${base}/versions/${v.ref.id}/safety-runs`, { expectedRevision: withdrawn.revision }), 201).run;
    await x.drain();
    const after = await viewOf(x, v.ref.id);
    assert.equal(after.ref.status, 'suspended');
    assert.equal(after.latestRun?.id, run.id);
    assert.equal(after.latestRun?.state, 'failed', 'manifest-holds saw the raised built-in');
  });

  await t.test('a dead suite job does not leave a run open for ever or a version on a stale suite', async () => {
    const v = await testedVersion(x, manifestOf(uniqueKey('dead')));
    await activateRoute(x, v.ref.extensionId);
    ok(await activateVersion(x, [v.ref.id]));
    const next = '0.3.0';
    assert.ok(await inTransaction(x.runtime.pool, (trx) => agentExtensionWorker.engineTick(trx, next)) >= 1);
    const open = (await admin.query<{ id: string }>("SELECT id FROM trustwork.agent_extension_safety_run WHERE version_id = $1 AND state = 'requested'", [v.ref.id])).rows[0]!;
    await withMaintenance(admin, (trx) => sql`UPDATE trustwork.job SET state = 'dead' WHERE kind = 'agents.extension_safety_run' AND payload ->> 'runId' = ${open.id}`.execute(trx));
    await inTransaction(x.runtime.pool, (trx) => agentExtensionWorker.engineTick(trx, next));
    const dead = await viewOf(x, v.ref.id);
    assert.equal(dead.ref.status, 'suspended');
    assert.match(dead.statusReason ?? '', /did not finish on engine 0\.3\.0/);
    assert.equal(dead.latestRun?.state, 'failed');
    assert.equal((await admin.query("SELECT 1 FROM trustwork.agent_extension_safety_run WHERE version_id = $1 AND state = 'requested'", [v.ref.id])).rowCount, 0, 'the run no longer blocks the next one');

    // A hung job is the same after its deadline; a dead rerun of a version on the current engine costs it nothing.
    await inTransaction(x.runtime.pool, (trx) => agentExtensionWorker.engineTick(trx, ENGINE));
    await admin.query("DELETE FROM trustwork.job WHERE state = 'queued' AND kind = 'agents.extension_safety_run'");
    const healthy = await testedVersion(x, manifestOf(uniqueKey('healthy')));
    await activateRoute(x, healthy.ref.extensionId);
    ok(await activateVersion(x, [healthy.ref.id]));
    const current = await viewOf(x, healthy.ref.id);
    ok(await command(staff.owner, `${base}/versions/${healthy.ref.id}/safety-runs`, { expectedRevision: current.revision }), 201);
    await inTransaction(x.runtime.pool, (trx) => agentExtensionWorker.engineTick(trx, ENGINE, 100, 0));
    const kept = await viewOf(x, healthy.ref.id);
    assert.equal(kept.latestRun?.state, 'failed', 'the hung run expired');
    assert.equal(kept.ref.status, 'active', 'its passing suite is from this engine');
  });

  await t.test('negative: no writer moves a version around the guards, not even the owner role', async () => {
    const v = await testedVersion(x, manifestOf(uniqueKey('guards')));
    const m = (fn: Parameters<typeof withMaintenance>[1]) => withMaintenance(admin, fn);
    await rejects(m((trx) => trx.updateTable('agent_extension_version').set({ manifest: { key: 'other' } }).where('id', '=', v.ref.id).execute()), '23000', 'agents.version_immutable');
    await rejects(m((trx) => trx.deleteFrom('agent_extension_version').where('id', '=', v.ref.id).execute()), '23000', 'audit.append_only');
    await rejects(m((trx) => trx.updateTable('agent_extension_version').set({ status: 'draft' }).where('id', '=', v.ref.id).execute()), '23514', 'agents.invalid_transition');
    await rejects(m((trx) => trx.updateTable('agent_extension_version').set({ status: 'active' }).where('id', '=', v.ref.id).execute()), '23514');
    await rejects(m((trx) => trx.updateTable('agent_extension_version').set({ status: 'active', approved_by: w.people.owner, approval_id: null }).where('id', '=', v.ref.id).execute()), '23514');
    await rejects(m((trx) => trx.deleteFrom('agent_extension_transition').where('version_id', '=', v.ref.id).execute()), '23000');
    const drafted = await draftVersion(x, manifestOf(uniqueKey('guards')));
    await rejects(m((trx) => trx.updateTable('agent_extension_version').set({ status: 'tested' }).where('id', '=', drafted.ref.id).execute()), '23514');
    const passing = v.latestRun?.id as string;
    await rejects(m((trx) => trx.updateTable('agent_extension_version').set({ status: 'tested', passing_run_id: passing }).where('id', '=', drafted.ref.id).execute()), '23514', 'agents.suite_required');
    await rejects(m((trx) => trx.updateTable('agent_extension_safety_run').set({ state: 'failed' }).where('id', '=', passing).execute()), '23000', 'agents.invalid_transition');
  });

  await t.test('a forged configuration through the generic hub route is refused by the activation hook', async () => {
    const v = await draftVersion(x, manifestOf(uniqueKey('forged')));
    const payload = { schemaVersion: 1, activeVersions: [{ extensionId: v.ref.extensionId, versionId: v.ref.id, manifestDigest: v.ref.manifestDigest.value }] };
    const c = await a.cmd(w.people.owner, (trx, ctx) => hubConfig.draft(trx, ctx, hubId, 'agent_extensions', payload));
    const digest = await import('../../packages/contracts/src/hub-core.js').then(({ configActivationDigestInput }) => configActivationDigestInput({ id: c.id, hubId, domain: 'agent_extensions', version: c.version, payloadDigest: c.payload_digest }));
    const approvalId = await a.approve(w.people.officer, w.people.owner, 'agents.activate_extension', hubId, digest);
    await rejects(a.cmd(w.people.officer, (trx, ctx) => hubConfig.activate(trx, ctx, c.id, c.revision, approvalId)), '23514', 'agents.version_not_ready');
    assert.equal((await viewOf(x, v.ref.id)).ref.status, 'draft');
  });

  await t.test('concurrency: one approval activates once; drafts of one key take distinct versions', async () => {
    const key = uniqueKey('race');
    const [one, two] = await Promise.all([command(staff.owner, `${base}/versions`, { manifest: manifestOf(key) }), command(staff.officer, `${base}/versions`, { manifest: manifestOf(key) })]);
    const versions = [one, two].map((r) => ok<CommandBody & { version: { ref: { version: number; id: string; extensionId: string } } }>(r, 201).version.ref);
    assert.deepEqual(versions.map((r) => r.version).sort(), [1, 2]);
    assert.equal(new Set(versions.map((r) => r.extensionId)).size, 1);
    const v = await testedVersion(x, manifestOf(uniqueKey('race')));
    await activateRoute(x, v.ref.extensionId);
    const proposed = ok<ActivationBody>(await command(staff.officer, `${base}/activations`, { versionIds: [v.ref.id] }), 201).activation;
    const url = `${base}/activations/${proposed.configVersionId}/activate`;
    const pending = ok<CommandBody>(await command(staff.owner, url, { expectedRevision: proposed.revision, approvalId: null }));
    const approvalId = pending.result.approvalRequestId as string;
    ok(await command(staff.officer, `/v1/admin/approvals/${approvalId}/approve`, { actionDigest: proposed.activation.actionDigest }));
    const results = await Promise.all([command(staff.owner, url, { expectedRevision: proposed.revision, approvalId }), command(staff.owner, url, { expectedRevision: proposed.revision, approvalId })]);
    assert.deepEqual(results.map((r) => r.status === 200).filter(Boolean).length, 1, JSON.stringify(results.map((r) => r.body)));
    assert.equal((await viewOf(x, v.ref.id)).ref.status, 'active');
  });

  await t.test('no staff route of the registry names a participant', () => {
    const source = readFileSync(new URL('../../apps/api/src/modules/agent-extensions/agent-extensions.controller.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /personId|mandateId|connectionId|principal/i);
  });
});
