import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { withMaintenance, type DataPool } from '@trustwork/data';
import { adminDigests, approvals, staffAssignments, staffRoleDefinitions } from '../../../packages/data/src/repositories/admin.js';
import { meteredPrices } from '../../../packages/data/src/repositories/agent-metering.js';
import type { MeteredCostInput, MeteredPriceDraftTerms, MeteredPriceVersion } from '../../../packages/contracts/src/agent-metering.js';
import { createApp } from '../../../apps/api/src/app.js';
import { actors, buildHubWorld, syncKernel } from '../../hubs/helpers.js';
import { registerFeeServingHubs } from '../fees/helpers.js';
import { Client, type Harness } from '../../backend/helpers/app.js';
import { addLogins, enrolNow, signIn } from '../../admin/helpers.js';
import { codeNow } from '../../backend/second-factor/helpers.js';

export const COMMERCE_PERMISSIONS = [
  'admin.commerce.price.draft', 'admin.commerce.price.activate', 'admin.commerce.plan.activate', 'admin.commerce.offer.edit', 'admin.commerce.usage.read', 'admin.moderation.read', 'admin.moderation.case.open', 'admin.audit.read',
] as const;

/** Synthetic people, hubs and prices only; real database roles, elevations and second-person approvals. */
export async function meteringWorld(admin: DataPool, runtime: DataPool) {
  await syncKernel(admin);
  const w = await buildHubWorld(admin);
  const a = actors(admin, runtime, w);
  const p = w.people;
  await a.assignSensitive({ personId: p.operator, role: 'node-operator', scope: { kind: 'node', nodeId: w.nodeId } });
  const hubA = (await a.createHub('synthetic-metering-a')).hub_id;
  const hubB = (await a.createHub('synthetic-metering-b')).hub_id;
  await registerFeeServingHubs(admin, hubA, hubB);
  // Each hub has five staff people, so it is in full mode: the second person of a price acts through a different role.
  for (const role of ['hub-owner', 'compliance-officer'] as const) {
    await withMaintenance(admin, (trx) => staffRoleDefinitions.release(trx, {
      version: 2, role, scopes: ['hub'], permissions: [...COMMERCE_PERMISSIONS], caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null,
    }));
  }
  for (const [personId, hubId, role] of [[p.owner, hubA, 'hub-owner'], [p.officer, hubA, 'compliance-officer'], [p.otherOwner, hubB, 'hub-owner'], [p.moderator, hubB, 'compliance-officer']] as const) {
    const scope = { kind: 'hub', hubId } as const;
    const digest = adminDigests.assignment({ breakglass: false, personId, role, scope, definitionVersion: 2 });
    const request = await a.cmd(p.founder, (trx, ctx) => approvals.request(trx, ctx, { action: 'staff.assign_sensitive_role', scope, actionDigest: digest }));
    await a.cmd(p.founder2, (trx, ctx) => approvals.decide(trx, ctx, request.id, 'approve', digest));
    await a.cmd(p.founder, (trx, ctx) => staffAssignments.assign(trx, ctx, { personId, role, scope, definitionVersion: 2, approvalId: request.id }));
  }
  const approve = async (digest: string, hubId = hubA, requester = p.officer, approver = p.owner) => {
    const r = await a.cmd(requester, (trx, ctx) => approvals.request(trx, ctx, { action: 'commerce.activate_price_version', scope: { kind: 'hub', hubId }, actionDigest: digest }));
    await a.cmd(approver, (trx, ctx) => approvals.decide(trx, ctx, r.id, 'approve', digest));
    return r.id;
  };
  const recordCost = (cost: MeteredCostInput, hubId = hubA, person = p.owner) => a.cmd(person, (trx, ctx) => meteredPrices.recordCost(trx, ctx, hubId, cost));
  const draft = (terms: MeteredPriceDraftTerms, hubId = hubA, person = p.owner) => a.cmd(person, (trx, ctx) => meteredPrices.draft(trx, ctx, hubId, terms));
  const activate = (v: MeteredPriceVersion, approvalId: string, person = p.officer, digest = v.digest) => a.cmd(person, (trx, ctx) => meteredPrices.activate(trx, ctx, v.hubId, v.id, digest, approvalId));
  /** Drafts and activates one price with a second person, effective shortly after. */
  const publish = async (terms: MeteredPriceDraftTerms, hubId = hubA) => {
    const version = await draft(terms, hubId);
    return activate(version, await approve(version.digest, hubId));
  };
  return { w, a, p, hubA, hubB, approve, recordCost, draft, activate, publish };
}

const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60000).toISOString();
export const syntheticCost = (overrides: Partial<MeteredCostInput> = {}): MeteredCostInput => ({
  subject: { kind: 'capability', key: 'project_planner.share_item', meter: 'agent_actions' }, currency: 'USD', costPerUnitMinor: '3.25', basis: 'measured_average',
  observedAt: new Date(Date.now() - 60000).toISOString(), ...overrides,
});
export const syntheticTerms = (overrides: Partial<MeteredPriceDraftTerms> = {}): MeteredPriceDraftTerms => ({
  subject: { kind: 'capability', key: 'project_planner.share_item', meter: 'agent_actions' }, currency: 'USD', basis: { kind: 'flat', salePerUnitMinor: '10' },
  effectiveFrom: inMinutes(5), effectiveTo: null, acceptanceTextVersion: 'synthetic-metered-1', ...overrides,
});

export async function meteringHttpWorld(h: Harness) {
  const world = await meteringWorld(h.db.admin, h.pool);
  const app = await createApp({
    env: { API_HOST: '127.0.0.1', API_PORT: '0', PUBLIC_ORIGIN: 'https://trustwork.test', AUTH_RATE_LIMIT_PER_MINUTE: '5000', AUTH_LOCKOUT_THRESHOLD: '50', TRUSTWORK_HUB_ID: world.hubA, MAIL_SECRET_KEY: randomBytes(32).toString('hex') },
    pool: h.pool, clock: h.clock,
    logSink: (line) => { if (line.includes('"level":"error"')) console.error('[metering-api]', line); },
  });
  const keys = ['owner', 'officer', 'otherOwner', 'outsider'] as const;
  const clients = {} as Record<(typeof keys)[number], Client>;
  const secrets = {} as Record<(typeof keys)[number], Buffer>;
  await addLogins(h, keys.map((k) => [world.p[k], `synthetic-metering-${k.toLowerCase()}@example.invalid`]));
  for (const key of keys) {
    clients[key] = new Client(app);
    await signIn(clients[key], `synthetic-metering-${key.toLowerCase()}@example.invalid`);
    secrets[key] = await enrolNow(h, clients[key]);
  }
  const elevate = async () => {
    h.clock.advance(30000);
    for (const key of ['owner', 'officer'] as const) {
      const r = await clients[key].post('/v1/admin/session/elevate', { proof: { method: 'totp', code: codeNow(h, secrets[key]) } }, { idempotencyKey: null });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
  };
  return { ...world, app, clients, elevate, anonymous: new Client(app) };
}
