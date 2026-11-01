import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AGGREGATE_MIN_COHORT, CONSOLE_SECOND_PERSON_ACTIONS, suppressSmallCount, type ConsoleSecondPersonAction } from '@trustwork/contracts/client';
import { isRestricted } from '@trustwork/country-packs';
import { permissionsFor, rolesFor } from '../../../../apps/web/app/admin/_data/access.js';
import { APPROVER_PERMISSIONS, approvalBlocker, evaluateCommand, REJECT_CODES, type CommandContext, type CommandInput, type CommandOutcome } from '../../../../apps/web/app/admin/_data/commands.js';
import { consolePort } from '../../../../apps/web/app/admin/_data/index.js';
import { ApprovalRequestSchema } from '../../../../apps/web/app/admin/_data/schemas.js';
import { SECTIONS } from '../../../../apps/web/app/admin/_data/sections.js';
import { FIXTURE_NOW, HUB_SAMARKAND_ID, HUB_US_ID, NODE_ID } from '../../../../apps/web/app/admin/_fixtures/ids.js';
import { HUBS } from '../../../../apps/web/app/admin/_fixtures/hubs.js';
import { STAFF, STAFF_PERSONAS } from '../../../../apps/web/app/admin/_fixtures/staff.js';
import { APPROVAL_REQUESTS } from '../../../../apps/web/app/admin/hubs/[hub]/approvals/_fixtures.js';
import { LEGAL_DOCUMENTS } from '../../../../apps/web/app/admin/hubs/[hub]/hub/legal/_fixtures.js';
import { PRODUCT_COMMANDS, PRODUCT_COMMAND_PERMISSIONS, PRODUCT_REJECT_CODES } from '../../../../apps/web/app/admin/hubs/[hub]/modules/_kit/commands.js';
import { HUB_PRODUCTS, productFor } from '../../../../apps/web/app/admin/hubs/[hub]/modules/_kit/product.js';
import { ABUSE_SIGNALS, ActivationPreviewSchema, AUDIENCES, CohortSchema, HubProductSchema, JOB_TRIGGERS, METERING_UNITS, type ActivationPreview, type HubProduct } from '../../../../apps/web/app/admin/hubs/[hub]/modules/_kit/schemas.js';

/**
 * HUBC-005: the agent product, product modules, billing and communications screens on fixtures. The acceptance
 * criteria as tests: cohorts under ten are suppressed, prices, commissions and extension activation need a second person,
 * nothing lists or manages one participant's agent, every activation carries its stored preview without named
 * participants, and no control can switch off mandates, confirmations, sanctions gates, restricted places or payment
 * neutrality. Negative authorization and optimistic concurrency are tested on the shared command evaluation.
 */

const now = new Date(FIXTURE_NOW);
const us = HUBS.find((h) => h.hub.id === HUB_US_ID)!;
const samarkand = HUBS.find((h) => h.hub.id === HUB_SAMARKAND_ID)!;
const usProduct = productFor(HUB_US_ID)!;
const usTarget = { nodeId: NODE_ID, hubId: HUB_US_ID };
const person = (persona: keyof typeof STAFF_PERSONAS) => STAFF.people.find((p) => p.id === STAFF_PERSONAS[persona])!;

function ctx(persona: keyof typeof STAFF_PERSONAS, overrides: Partial<CommandContext> = {}, target = usTarget): CommandContext {
  const p = person(persona);
  const hub = target.hubId === HUB_US_ID ? us : samarkand;
  return {
    viewer: { person: p, elevation: { state: 'elevated', until: '2026-10-31T12:30:00Z' } },
    access: { roles: rolesFor(STAFF, p.id, target, now), permissions: [...permissionsFor(STAFF, p.id, target, now)] },
    hub,
    now,
    offline: false,
    requests: APPROVAL_REQUESTS,
    documents: LEGAL_DOCUMENTS,
    setup: null,
    isRestricted,
    product: productFor(hub.hub.id),
    ...overrides,
  };
}
const input = (command: CommandInput['command'], fields: Record<string, string> = {}, extra: Partial<CommandInput> = {}): CommandInput => ({
  command,
  hubSlug: 'us-demo',
  setupToken: null,
  reason: 'Synthetic test reason',
  expectedRevision: us.hub.revision,
  fields,
  ...extra,
});
const code = (outcome: CommandOutcome) => (outcome.status === 'rejected' ? outcome.code : outcome.status);
const secondPerson = (outcome: CommandOutcome) => (outcome.status === 'demo_not_saved' ? outcome.secondPerson : `not accepted: ${code(outcome)}`);
const withProduct = (change: (p: HubProduct) => void): HubProduct => {
  const copy = structuredClone(usProduct) as HubProduct;
  change(copy);
  return HubProductSchema.parse(copy);
};

/** Every stored preview in the fixtures, wherever it sits. */
function previews(node: unknown, out: ActivationPreview[] = []): ActivationPreview[] {
  if (Array.isArray(node)) node.forEach((n) => previews(n, out));
  else if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    if ('digest' in record && 'affected' in record && 'changes' in record) out.push(record as unknown as ActivationPreview);
    else Object.values(record).forEach((v) => previews(v, out));
  }
  return out;
}

/** Every object key in a tree (knowledge shares are contract records of a participant's own consent and are skipped). */
function keys(node: unknown, path = '', out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n, i) => keys(n, `${path}[${i}]`, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'shares') continue;
      out.push(`${path}.${k}`);
      keys(v, `${path}.${k}`, out);
    }
  }
  return out;
}

/* ---------- Fixtures and the shapes ---------- */

test('product fixtures parse for both example hubs and every new section is built', () => {
  assert.deepEqual(HUB_PRODUCTS.map((p) => p.hubId).sort(), [HUB_SAMARKAND_ID, HUB_US_ID].sort());
  for (const product of HUB_PRODUCTS) assert.equal(HubProductSchema.safeParse(product).success, true);
  const built = SECTIONS.filter(({ group }) => ['modules', 'agents', 'billing', 'communications'].includes(group.id));
  for (const { group, section } of built) assert.equal(section.status, group.id === 'modules' && section.id === 'procurement' ? 'designed' : 'demo', `${group.id}.${section.id}`);
});

test('the port serves the product in demo mode only', async () => {
  assert.equal((await consolePort(true).product(HUB_US_ID))?.hubId, HUB_US_ID);
  assert.equal(await consolePort(true).product('no-such-hub'), null);
  assert.equal(await consolePort(false).product(HUB_US_ID), null, 'live mode has no product backend yet');
});

/* ---------- Acceptance: cohorts under ten are suppressed ---------- */

test('cohort counts under ten are suppressed: the schema refuses them and the fixtures arrive as null', () => {
  assert.equal(AGGREGATE_MIN_COHORT, 10);
  for (const raw of [0, 1, 7, 9]) {
    assert.equal(suppressSmallCount(raw), null);
    assert.equal(CohortSchema.safeParse(raw).success, false, `${raw} cannot be stored as a cohort`);
  }
  assert.equal(CohortSchema.safeParse(10).success, true);
  assert.equal(CohortSchema.safeParse(null).success, true);
  const rfq = usProduct.agents.usage.find((u) => u.moduleKey === 'rfq_responder')!;
  assert.equal(rfq.activePrincipals, null, 'seven active principals arrive as "fewer than 10"');
  assert.equal(rfq.actionsEscalatedToHumans, null);
  assert.equal(usProduct.agents.external.registeredClients.a2a, null);
  assert.equal(usProduct.agents.cohorts.find((c) => c.key === 'company_team')?.activePrincipals, null);
  // Every number that counts participants in the whole product is null or at least ten.
  const cohortFields = /^(activePrincipals|runs|actionsSucceeded|actionsEscalatedToHumans|mandates|jobSubscriptions|externalConnections|openRuns|payers|acceptances|payees|invoices|audienceSize|sent|created|published|completed|openRequests|engagements|issued|revoked|expired|registrations|checkIns|needsPublished|needsFilled|introductionsRequested|introductionsAccepted|rfqs|quotes|agreements|orders|plansCreated|pausedForExpiredLicence|mcp|a2a)$/;
  const offenders: string[] = [];
  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node)) node.forEach((n, i) => walk(n, `${path}[${i}]`));
    else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) {
      if (cohortFields.test(k) && typeof v === 'number' && v < AGGREGATE_MIN_COHORT) offenders.push(`${path}.${k}=${v}`);
      walk(v, `${path}.${k}`);
    }
  };
  for (const product of HUB_PRODUCTS) walk({ agents: product.agents, modules: product.modules, billing: product.billing, communications: product.communications }, product.hubId);
  assert.deepEqual(offenders, []);
});

test('the screens render a suppressed cohort as "fewer than 10", never as a number', () => {
  const parts = readFileSync(resolve('apps/web/app/admin/hubs/[hub]/modules/_kit/parts.tsx'), 'utf8');
  assert.match(parts, /if \(value === null\) return <span data-suppressed="true">\{t\('admin\.product\.fewerThan10'\)\}<\/span>/);
  const en = JSON.parse(readFileSync(resolve('apps/web/locales/en/admin.json'), 'utf8')).admin;
  assert.equal(en.product.fewerThan10, 'fewer than 10');
});

/* ---------- Acceptance: activation previews, counts only ---------- */

test('every stored preview parses, carries a digest and cohort counts, and names no participant', () => {
  const all = HUB_PRODUCTS.flatMap((p) => previews(p));
  assert.ok(all.length >= 10, `found ${all.length} previews`);
  const allowed = ['id', 'digest', 'computedAt', 'changes', 'affected', 'audiences', 'plans', 'advanceNoticeDays', 'estimatedMonthlyCostChange', 'synthetic'];
  const people = new Set(STAFF.people.flatMap((p) => [p.id, p.displayName]));
  for (const preview of all) {
    assert.equal(ActivationPreviewSchema.safeParse(preview).success, true, preview.id);
    assert.deepEqual(Object.keys(preview).sort(), [...allowed].sort(), `${preview.id}: no other field`);
    const text = JSON.stringify(preview);
    for (const p of people) assert.ok(!text.includes(`"${p}"`), `${preview.id} names ${p}`);
    assert.ok(!/"(personId|participantId|agentId|mandateId|principalId|name|displayName)":/.test(text), `${preview.id} carries no participant identifier`);
  }
  // A preview with a person in it is refused by the schema.
  const sample = all[0]!;
  assert.equal(ActivationPreviewSchema.safeParse({ ...sample, affectedPeople: ['pp-demo-owner-1'] }).success, false);
  assert.equal(ActivationPreviewSchema.safeParse({ ...sample, affected: { ...sample.affected, mandates: 3 } }).success, false);
});

test('every activation screen shows the stored preview of the draft it activates', () => {
  const screens = ['agents/modules', 'agents/extensions', 'agents/policy', 'billing/prices', 'billing/offers', 'billing/credits', 'modules/marketplace'];
  for (const path of screens) {
    const source = readFileSync(resolve(`apps/web/app/admin/hubs/[hub]/${path}/_screen.tsx`), 'utf8');
    assert.match(source, /<ActivationRequest[\s\S]*?preview=\{/, `${path} uses the activation request with a preview`);
  }
  const parts = readFileSync(resolve('apps/web/app/admin/hubs/[hub]/modules/_kit/parts.tsx'), 'utf8');
  assert.match(parts, /preview \? <PreviewPanel ctx=\{ctx\} preview=\{preview\}/, 'the activation request renders the preview above the form');
  assert.match(parts, /'f\.previewDigest': preview\.digest\.value/, 'the request carries the preview digest');
});

/* ---------- Acceptance: second person for price, commission and extension activation ---------- */

test('price, plan, credit-pack, commission, extension, commitment-module and jurisdiction activation only ever create a second-person request', () => {
  const planner = usProduct.billing.prices.find((r) => r.price.priceVersionId === 'pr-planner-2')!;
  const plan = usProduct.billing.plans.find((p) => p.plan.status === 'draft')!;
  const pack = usProduct.billing.credits.packs.find((p) => p.status === 'draft')!;
  const fee = usProduct.modules.marketplace.fees.find((f) => f.fee.status === 'draft')!;
  const ext = usProduct.agents.extensions.find((e) => e.ref.status === 'tested')!;
  const orderDesk = usProduct.agents.modules.find((m) => m.key === 'order_desk')!;
  const cases: Array<[CommandInput['command'], Record<string, string>, keyof typeof STAFF_PERSONAS, ConsoleSecondPersonAction]> = [
    ['billing.price.request_activation', { priceVersionId: planner.price.priceVersionId, previewDigest: planner.preview!.digest.value }, 'commercial', 'commerce.activate_price_version'],
    ['billing.plan.request_activation', { planId: plan.plan.id, previewDigest: plan.preview!.digest.value }, 'commercial', 'commerce.activate_price_version'],
    ['billing.pack.request_activation', { packId: pack.id, previewDigest: pack.preview!.digest.value }, 'commercial', 'commerce.activate_price_version'],
    ['marketplace.fee.request_activation', { feeId: fee.fee.id, previewDigest: fee.preview!.digest.value }, 'commercial', 'billing.activate_fee_version'],
    ['extensions.request_activation', { extensionVersionId: ext.ref.id, previewDigest: ext.preview!.digest.value }, 'hub-owner', 'agents.activate_extension'],
    ['agents.module.request_activation', { moduleKey: orderDesk.key, previewDigest: orderDesk.draft!.preview.digest.value }, 'hub-owner', 'agents.enable_commitment_module'],
    ['jurisdiction.request_activation', { configVersionId: 'cv-jur-us-ca-2' }, 'hub-owner', 'jurisdiction.activate_settings'],
    ['billing.payout.request_release', { batchId: 'pb-experts-10' }, 'commercial', 'billing.release_payout_batch'],
  ];
  for (const [command, fields, persona, action] of cases) {
    const outcome = evaluateCommand(input(command, fields), ctx(persona));
    if (command === 'jurisdiction.request_activation') {
      assert.equal(code(outcome), 'not_draft', 'the active California version is not a draft');
      continue;
    }
    assert.equal(secondPerson(outcome), action, command);
    assert.ok((CONSOLE_SECOND_PERSON_ACTIONS as readonly string[]).includes(action));
  }
  // Texas is a draft, but its Spanish disclosure is missing.
  const texas = evaluateCommand(input('jurisdiction.request_activation', { configVersionId: 'cv-jur-us-tx-1' }), ctx('hub-owner'));
  assert.deepEqual(texas, { status: 'rejected', code: 'language_missing', field: 'configVersionId', detail: ['es'] });
  // There is no command that activates any of these directly.
  assert.deepEqual(PRODUCT_COMMANDS.filter((c) => /(^|\.)activate$/.test(c) && !c.startsWith('comms.')), []);
});

test('the requester can never approve their own activation, and approvers need the activation permission', () => {
  const request = (action: ConsoleSecondPersonAction, requestedBy: string) =>
    ApprovalRequestSchema.parse({
      id: `rq-test-${action}`,
      hubId: HUB_US_ID,
      action,
      scope: { kind: 'hub', hubId: HUB_US_ID },
      actionDigest: { algorithm: 'trustwork-digest-1', value: 'ab'.repeat(32) },
      currentDigest: { algorithm: 'trustwork-digest-1', value: 'ab'.repeat(32) },
      requestedBy,
      reason: { value: 'Synthetic', lang: 'en' },
      requestedAt: '2026-10-31T11:00:00Z',
      expiresAt: '2026-11-03T11:00:00Z',
      changes: [{ field: 'salePrice', before: { kind: 'none' }, after: { kind: 'text', value: '12', lang: 'en' } }],
      state: 'pending',
      synthetic: true,
    });
  const access = (persona: keyof typeof STAFF_PERSONAS) => ({ roles: rolesFor(STAFF, person(persona).id, usTarget, now), permissions: [...permissionsFor(STAFF, person(persona).id, usTarget, now)] });
  const price = request('commerce.activate_price_version', person('commercial').id);
  assert.equal(approvalBlocker(price, person('commercial').id, access('commercial'), now), 'own_request', 'the drafter cannot approve their price');
  assert.equal(approvalBlocker(price, person('hub-owner').id, access('hub-owner'), now), 'denied', 'a hub owner without price activation cannot approve');
  const fee = request('billing.activate_fee_version', person('commercial').id);
  assert.equal(approvalBlocker(fee, person('commercial').id, access('commercial'), now), 'own_request');
  const ext = request('agents.activate_extension', person('hub-owner').id);
  assert.equal(approvalBlocker(ext, person('hub-owner').id, access('hub-owner'), now), 'own_request', 'the hub owner drafts extensions and cannot activate them');
  assert.equal(approvalBlocker(ext, person('compliance').id, access('compliance'), now), null, 'the compliance officer is the second person');
  assert.deepEqual(APPROVER_PERMISSIONS['agents.activate_extension'], ['admin.agents.extensions.activate']);
  // The approval decision re-checks the same rule on the server.
  const decided = evaluateCommand(input('approvals.decide', { requestId: ext.id, decision: 'approve', digest: ext.actionDigest.value }), ctx('hub-owner', { requests: [ext] }));
  assert.equal(code(decided), 'own_request');
  assert.equal(code(evaluateCommand(input('approvals.decide', { requestId: ext.id, decision: 'approve', digest: ext.actionDigest.value }), ctx('compliance', { requests: [ext] }))), 'demo_not_saved');
});

test('an activation request is bound to the stored preview: another digest, a back-dated or overlapping version, a failing safety suite are refused', () => {
  const planner = usProduct.billing.prices.find((r) => r.price.priceVersionId === 'pr-planner-2')!;
  assert.equal(code(evaluateCommand(input('billing.price.request_activation', { priceVersionId: planner.price.priceVersionId, previewDigest: 'cd'.repeat(32) }), ctx('commercial'))), 'digest_mismatch');
  assert.equal(code(evaluateCommand(input('billing.price.request_activation', { priceVersionId: 'pr-rfq-1', previewDigest: 'x' }), ctx('commercial'))), 'not_draft', 'an active version cannot be activated again');
  assert.equal(code(evaluateCommand(input('billing.price.request_activation', { priceVersionId: 'no-such-version' }), ctx('commercial'))), 'not_found');
  const backDated = withProduct((p) => {
    p.billing.prices.find((r) => r.price.priceVersionId === 'pr-planner-2')!.effectiveFrom = '2026-10-30T00:00:00Z';
  });
  assert.equal(code(evaluateCommand(input('billing.price.request_activation', { priceVersionId: 'pr-planner-2', previewDigest: planner.preview!.digest.value }), ctx('commercial', { product: backDated }))), 'back_dated');
  const draft = (fields: Record<string, string>) => code(evaluateCommand(input('billing.price.draft', fields), ctx('commercial')));
  assert.equal(draft({ subject: 'module:rfq_responder', basis: 'flat', sale: '12', effectiveFrom: '2026-10-01' }), 'back_dated');
  assert.equal(draft({ subject: 'module:project_planner', basis: 'flat', sale: '12', effectiveFrom: '2027-01-01' }), 'overlap', 'a draft already exists for the planner');
  assert.equal(draft({ subject: 'module:rfq_responder', basis: 'markup', percent: '150', effectiveFrom: '2027-01-01' }), 'demo_not_saved');
  assert.equal(draft({ subject: 'module:rfq_responder', basis: 'flat', sale: '-3', effectiveFrom: '2027-01-01' }), 'invalid');
  const fee = (fields: Record<string, string>) => code(evaluateCommand(input('marketplace.fee.draft', fields), ctx('commercial')));
  assert.equal(fee({ kind: 'consultation', basisPoints: '700', effectiveFrom: '2026-10-15' }), 'back_dated');
  assert.equal(fee({ kind: 'consultation', basisPoints: '700', effectiveFrom: '2027-02-01' }), 'demo_not_saved');
  assert.equal(fee({ kind: 'consultation', basisPoints: '10001', effectiveFrom: '2027-02-01' }), 'invalid');
  const weather = usProduct.agents.extensions.find((e) => e.ref.key === 'weather_window')!;
  assert.equal(code(evaluateCommand(input('extensions.request_activation', { extensionVersionId: weather.ref.id }), ctx('hub-owner'))), 'safety_suite_failed');
  const unverified = withProduct((p) => {
    p.agents.modules.find((m) => m.key === 'order_desk')!.verifiedCompanyRequired = false;
  });
  const desk = usProduct.agents.modules.find((m) => m.key === 'order_desk')!;
  assert.equal(code(evaluateCommand(input('agents.module.request_activation', { moduleKey: 'order_desk', previewDigest: desk.draft!.preview.digest.value }), ctx('hub-owner', { product: unverified }))), 'commitment_requires_verified');
  const planner3 = usProduct.agents.modules.find((m) => m.key === 'project_planner')!;
  assert.equal(secondPerson(evaluateCommand(input('agents.module.request_activation', { moduleKey: 'project_planner', previewDigest: planner3.draft!.preview.digest.value }), ctx('hub-owner'))), null, 'a module without commitment actions activates with one person');
});

/* ---------- Acceptance: no per-participant agent management; locked guard rails ---------- */

test('no product record points to one participant, their agent, mandate, goal, job subscription or connection', () => {
  for (const product of HUB_PRODUCTS) {
    const found = keys({ agents: product.agents, billing: product.billing, communications: product.communications, modules: product.modules }).filter((k) =>
      /\.(personId|participantId|agentId|mandateId|goalId|subscriptionId|connectionId|principalId|actingFor|ownerParty|namedParties)$/.test(k),
    );
    assert.deepEqual(found, [], product.hubId);
  }
});

test('no command accepts a field that points at one participant: staff configure the product for everyone', () => {
  const tries: Array<[CommandInput['command'], Record<string, string>, (keyof typeof STAFF_PERSONAS)?]> = [
    ['agents.module.draft', { moduleKey: 'research', baseVersion: '2', personId: 'pp-demo-owner-1' }],
    ['agents.module.draft', { moduleKey: 'research', baseVersion: '2', agentId: 'ag-1' }],
    ['agents.policy.draft', { baseVersion: '3', participant: 'pp-demo-owner-1' }],
    ['external.save', { defaultPerMinute: '10', maximumPerMinute: '20', connectionId: 'cn-1' }],
    ['usage.export', { period: 'month', person: 'pp-demo-owner-1' }],
    ['billing.plan.draft', { offerId: 'of-pro-person', trialDays: '7', subscriptionId: 'sb-1' }, 'commercial'],
    ['agents.policy.draft', { baseVersion: '3', goal: 'g-1' }],
  ];
  for (const [command, fields, persona] of tries) assert.equal(code(evaluateCommand(input(command, fields), ctx(persona ?? 'hub-owner'))), 'per_person_forbidden', `${command} ${Object.keys(fields).join(',')}`);
});

test('no control can switch off mandates, confirmations for commitments, sanctions gates, restricted places or payment neutrality', () => {
  const guards = ['mandates', 'mandateRequired', 'confirmations', 'requireConfirmation', 'sanctionsGate', 'sanctionsScreening', 'restrictedPlaces', 'paymentNeutrality', 'rankingBoost', 'featured', 'score'];
  const commands: Array<[CommandInput['command'], Record<string, string>, keyof typeof STAFF_PERSONAS]> = [
    ['agents.policy.draft', { baseVersion: '3' }, 'hub-owner'],
    ['agents.module.draft', { moduleKey: 'order_desk', baseVersion: '1' }, 'hub-owner'],
    ['billing.plan.draft', { offerId: 'of-pro-person', trialDays: '7' }, 'commercial'],
    ['billing.price.draft', { subject: 'module:rfq_responder', basis: 'flat', sale: '12', effectiveFrom: '2027-01-01' }, 'commercial'],
    ['marketplace.fee.draft', { kind: 'task', basisPoints: '100', effectiveFrom: '2027-01-01' }, 'commercial'],
    ['extensions.draft', { key: 'demo_tool', actionKind: 'prepare' }, 'hub-owner'],
    ['external.save', { defaultPerMinute: '10', maximumPerMinute: '20' }, 'hub-owner'],
    ['matching.quota.save', { introductionsPerPersonPerWeek: '5' }, 'hub-owner'],
  ];
  for (const [command, fields, persona] of commands) {
    assert.equal(code(evaluateCommand(input(command, fields), ctx(persona))), 'demo_not_saved', `${command} is valid without a guard field`);
    for (const guard of guards) assert.equal(code(evaluateCommand(input(command, { ...fields, [guard]: 'off' }), ctx(persona))), 'guard_rail_locked', `${command} refuses ${guard}`);
  }
  // A project field outside the engine's public list (budgets) cannot be allowed.
  assert.equal(code(evaluateCommand(input('projects.policy.save', { baseVersion: '2', field: 'budget_range', include: 'true' }), ctx('hub-owner'))), 'guard_rail_locked');
  // Restricted places are refused for extension endpoints, jurisdictions and tax regions.
  assert.equal(code(evaluateCommand(input('extensions.draft', { key: 'demo_tool', actionKind: 'prepare', endpointHost: 'api.partner.example', endpointCountry: 'RU' }), ctx('hub-owner'))), 'territory_restricted');
  assert.equal(code(evaluateCommand(input('jurisdiction.draft', { jurisdiction: 'IR', area: 'consent', comparison: 'same', value: 'x' }), ctx('hub-owner'))), 'territory_restricted');
  assert.equal(code(evaluateCommand(input('jurisdiction.draft', { jurisdiction: 'US-CA', area: 'consent', comparison: 'weaker', value: 'x' }), ctx('hub-owner'))), 'weaker_than_pack');
  assert.equal(code(evaluateCommand(input('billing.tax.save', { baseVersion: '1', region: 'CU', treatment: 'exempt', source: 'https://tax.example/cu' }), ctx('commercial'))), 'territory_restricted');
});

test('the screens offer no field named after a guard rail and no per-participant field', () => {
  const root = resolve('apps/web/app/admin/hubs/[hub]');
  const files = ['modules', 'agents', 'billing', 'communications'].flatMap((group) => list(join(root, group))).filter((f) => f.endsWith('.tsx'));
  assert.ok(files.length >= 25);
  const offenders: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const names = [...source.matchAll(/\bname="([^"]+)"/g), ...source.matchAll(/'f\.([A-Za-z]+)'/g)].map((m) => m[1]!);
    for (const name of names) if (/(mandate|confirm|sanction|restricted|neutral|rank|boost|featured|badge|score)/i.test(name) || /(person|participant|agent|principal)(_?id)?$/i.test(name)) offenders.push(`${file.slice(root.length)}: ${name}`);
    // No screen reaches participants' agents, mandates or their per-person routes.
    if (/mandateId|agentId|\/agents\/\$\{|participants\/people\//.test(source)) offenders.push(`${file.slice(root.length)}: per-person reference`);
  }
  assert.deepEqual(offenders, []);
  const guardPanel = readFileSync(join(root, 'modules/_kit/parts.tsx'), 'utf8');
  for (const rail of ['mandates', 'confirmations', 'sanctions', 'restrictedPlaces', 'paymentNeutrality']) assert.ok(guardPanel.includes(`'${rail}'`), `${rail} is shown as locked`);
});

function list(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? list(join(dir, name)) : [join(dir, name)]));
}

/* ---------- Negative authorization and concurrency ---------- */

test('negative authorization: each product command needs its own permission on this hub, an elevated session, a reason and the network', () => {
  for (const command of PRODUCT_COMMANDS) assert.ok(PRODUCT_COMMAND_PERMISSIONS[command].length > 0, command);
  const valid = { subject: 'module:rfq_responder', basis: 'flat', sale: '12', effectiveFrom: '2027-01-01' };
  assert.equal(code(evaluateCommand(input('billing.price.draft', valid), ctx('editor'))), 'denied', 'an editor cannot draft prices');
  assert.equal(code(evaluateCommand(input('billing.price.draft', valid), ctx('hub-owner'))), 'denied', 'the hub owner does not draft prices');
  assert.equal(code(evaluateCommand(input('billing.price.draft', valid), ctx('staff-none'))), 'denied');
  assert.equal(code(evaluateCommand(input('agents.module.draft', { moduleKey: 'research', baseVersion: '2' }), ctx('editor'))), 'denied', 'an editor does not change agent modules');
  assert.equal(code(evaluateCommand(input('extensions.suspend', { extensionVersionId: 'ext-permit-lookup-1' }), ctx('hub-owner'))), 'denied');
  assert.equal(code(evaluateCommand(input('extensions.suspend', { extensionVersionId: 'ext-permit-lookup-1' }), ctx('ops'))), 'demo_not_saved', 'suspending is one person with the permission');
  assert.equal(code(evaluateCommand(input('agents.kill', { scope: 'agent_module', target: 'research' }), ctx('compliance'))), 'denied');
  assert.equal(code(evaluateCommand(input('agents.kill', { scope: 'agent_module', target: 'research' }), ctx('ops'))), 'demo_not_saved');
  const samTarget = { nodeId: NODE_ID, hubId: HUB_SAMARKAND_ID };
  assert.equal(code(evaluateCommand(input('agents.module.draft', { moduleKey: 'research', baseVersion: '2' }, { hubSlug: 'samarkand' }), ctx('hub-owner', {}, samTarget))), 'denied', 'a US hub owner cannot act on Samarkand');
  const notElevated = ctx('commercial');
  notElevated.viewer = { ...notElevated.viewer!, elevation: { state: 'required' } };
  assert.equal(code(evaluateCommand(input('billing.price.draft', valid), notElevated)), 'elevation_required');
  assert.equal(code(evaluateCommand(input('billing.price.draft', valid), ctx('commercial', { offline: true }))), 'offline');
  assert.equal(code(evaluateCommand(input('billing.price.draft', valid, { reason: ' ' }), ctx('commercial'))), 'reason_required');
  assert.equal(code(evaluateCommand(input('billing.price.draft', valid), ctx('commercial', { product: null }))), 'not_found');
  assert.equal(code(evaluateCommand(input('billing.price.draft', valid), ctx('commercial', { product: productFor(HUB_SAMARKAND_ID) }))), 'not_found', 'another hub\'s product is never used');
  assert.equal(code(evaluateCommand(input('billing.credit.issue', { billingAccount: 'ba-demo-1', amountMinor: '6000' }), ctx('commercial'))), 'above_cap');
  assert.equal(code(evaluateCommand(input('billing.credit.issue', { billingAccount: 'ba-demo-1', amountMinor: '4000' }), ctx('commercial'))), 'demo_not_saved');
});

test('optimistic concurrency: a draft on an older configuration version is refused as stale', () => {
  const research = usProduct.agents.modules.find((m) => m.key === 'research')!;
  assert.equal(code(evaluateCommand(input('agents.module.draft', { moduleKey: 'research', baseVersion: String(research.version - 1) }), ctx('hub-owner'))), 'stale');
  assert.equal(code(evaluateCommand(input('agents.module.draft', { moduleKey: 'research' }), ctx('hub-owner'))), 'stale', 'a missing version is stale too');
  assert.equal(code(evaluateCommand(input('agents.module.draft', { moduleKey: 'research', baseVersion: String(research.version) }), ctx('hub-owner'))), 'demo_not_saved');
  assert.equal(code(evaluateCommand(input('agents.policy.draft', { baseVersion: '2' }), ctx('hub-owner'))), 'stale');
  assert.equal(code(evaluateCommand(input('projects.policy.save', { baseVersion: '1' }), ctx('hub-owner'))), 'stale');
  assert.equal(code(evaluateCommand(input('billing.tax.save', { baseVersion: '0', region: 'US-WA', treatment: 'exempt', source: 'https://tax.example/wa' }), ctx('commercial'))), 'stale');
  assert.equal(code(evaluateCommand(input('marketplace.rule.save', { categoryKey: 'architect_review', baseVersion: '1' }), ctx('commercial'))), 'stale');
  // Two staff members drafting from the same version: the second one, after the first created version 3, is stale.
  const afterFirst = withProduct((p) => {
    p.agents.modules.find((m) => m.key === 'research')!.version = research.version + 1;
  });
  assert.equal(code(evaluateCommand(input('agents.module.draft', { moduleKey: 'research', baseVersion: String(research.version) }), ctx('hub-owner', { product: afterFirst }))), 'stale');
});

test('defaults stay within the hub maximum, and module rules hold', () => {
  const draft = (fields: Record<string, string>) => code(evaluateCommand(input('agents.module.draft', { moduleKey: 'project_planner', baseVersion: '2', ...fields }), ctx('hub-owner')));
  assert.equal(draft({ defaultKey: 'outreach_per_week', value: '25' }), 'above_maximum');
  assert.equal(draft({ defaultKey: 'outreach_per_week', value: '25', maximum: '30' }), 'demo_not_saved');
  assert.equal(draft({ defaultKey: 'outreach_per_week', value: '12' }), 'demo_not_saved');
  assert.equal(draft({ capability: 'project_planner.propose_requests', scope: 'audience:external_client', state: 'off' }), 'demo_not_saved');
  assert.equal(draft({ capability: 'project_planner.propose_requests', scope: 'plan:no_such_plan', state: 'off' }), 'invalid');
  assert.equal(draft({ capability: 'research.search_public', scope: 'hub', state: 'off' }), 'invalid', 'a capability of another module');
  assert.equal(code(evaluateCommand(input('planner.publish', { templateId: 'pt-us-kitchen-1' }), ctx('editor'))), 'author_cannot_publish', 'the author cannot publish their own template');
  assert.equal(code(evaluateCommand(input('knowledge.decide', { shareId: 'ks-diary-1', decision: 'publish' }), ctx('editor'))), 'consent_missing');
  assert.equal(code(evaluateCommand(input('knowledge.decide', { shareId: 'ks-diary-1', decision: 'return' }), ctx('editor'))), 'demo_not_saved');
  assert.equal(code(evaluateCommand(input('marketplace.rule.save', { categoryKey: 'electrical_work', baseVersion: '1', whoMayOffer: 'claimed_company_or_professional' }), ctx('commercial'))), 'licence_requires_verified');
  assert.equal(code(evaluateCommand(input('comms.template.activate', { templateKey: 'price_change_notice' }), ctx('ops'))), 'language_missing');
  assert.equal(code(evaluateCommand(input('comms.announcement.send', { announcementId: 'an-demo-1' }), ctx('editor'))), 'demo_not_saved');
  assert.equal(code(evaluateCommand(input('billing.pack.draft', { credits: '100', priceMinor: '900', validity: 'days', validityDays: '10', reminderDays: '7' }), ctx('commercial'))), 'invalid', 'credits valid for less than 30 days are refused');
  assert.equal(code(evaluateCommand(input('billing.pack.draft', { credits: '100', priceMinor: '900', validity: 'days', validityDays: '60' }), ctx('commercial'))), 'invalid', 'expiring credits need a reminder');
  assert.equal(code(evaluateCommand(input('billing.pack.draft', { credits: '100', priceMinor: '900', validity: 'none' }), ctx('commercial'))), 'demo_not_saved');
});

/* ---------- Locale families ---------- */

test('every value family the screens build from data has English copy, and every product reject code has an error message', () => {
  const en = JSON.parse(readFileSync(resolve('apps/web/locales/en/admin.json'), 'utf8')).admin;
  const has = (path: string) => path.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), en) !== undefined;
  const families: Array<[string, readonly string[]]> = [
    ['product.audiences', AUDIENCES],
    ['product.units', METERING_UNITS],
    ['agents.modules.triggers', JOB_TRIGGERS],
    ['agents.abuse.signals', ABUSE_SIGNALS],
    ['product.plans', usProduct.agents.plans],
    ['product.moduleNames', usProduct.agents.modules.map((m) => m.key)],
    ['agents.modules.settings', usProduct.agents.modules.flatMap((m) => m.defaults.map((d) => d.key))],
    ['agents.modules.jobTemplates', usProduct.agents.modules.flatMap((m) => m.jobs.map((j) => j.key))],
    ['agents.modules.actions', usProduct.agents.modules.flatMap((m) => m.actions)],
    ['modules.marketplace.categories', usProduct.modules.marketplace.rules.map((r) => r.categoryKey)],
    ['modules.commerce.categories', usProduct.modules.commerce.rules.map((r) => r.categoryKey)],
    ['communications.templates.names', usProduct.communications.templates.map((x) => x.key)],
    ['product.fields', previews(usProduct).flatMap((p) => p.changes.map((c) => c.field))],
  ];
  const missing = families.flatMap(([prefix, values]) => [...new Set(values)].filter((v) => !has(`${prefix}.${v}`)).map((v) => `${prefix}.${v}`));
  for (const value of previews(usProduct).flatMap((p) => p.changes.flatMap((c) => [c.before, c.after]))) if (value.kind === 'key' && !has(value.key)) missing.push(value.key);
  for (const reject of PRODUCT_REJECT_CODES) {
    assert.ok((REJECT_CODES as readonly string[]).includes(reject));
    if (!has(`errors.${reject}`)) missing.push(`errors.${reject}`);
  }
  assert.deepEqual(missing, []);
});
