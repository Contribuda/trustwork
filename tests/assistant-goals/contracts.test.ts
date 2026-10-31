import test from 'node:test';
import assert from 'node:assert/strict';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { RequestMethod } from '@nestjs/common';
import * as agents from '../../packages/contracts/src/agents.js';
import * as catalog from '../../packages/contracts/src/agent-catalog.js';
import { AgentsController, CompanyRepresentativeController } from '../../apps/api/src/modules/assistant-goals/agents.controller.js';
import { AUTH_REQUIREMENT, IDEMPOTENT } from '../../apps/api/src/common/request.js';
import { IDEMPOTENT_ROUTES } from '../../apps/api/src/common/idempotency/routes.js';
import { mandateCoversNeed } from '../../apps/api/src/modules/assistant-goals/goals.service.js';

/**
 * AGT-001 contracts without a database: the negotiation state machine, the note guard, the goal and envelope command
 * schemas, and the capability registry against the mounted routes (ADR 010 decision 23: every operation is available to
 * the interface and to the agent, governance never to connections).
 */
const person = (id: string) => ({ kind: 'person' as const, id });
const company = (id: string) => ({ kind: 'company' as const, id });
const at = new Date('2026-11-01T00:00:00Z');
const open = { status: 'open' as const, maxRounds: 3, roundsUsed: 0, turn: null, expiresAt: '2026-11-10T00:00:00Z' };

test('negotiation sessions alternate, count rounds, end at the limit or at expiry, and agreement waits for people', () => {
  const buyer = person('buyer');
  const seller = company('seller');
  let s: { status: 'open' | 'agreed_pending_confirmation' | 'escalated' | 'declined' | 'withdrawn' | 'expired'; maxRounds: number; roundsUsed: number; turn: { kind: 'person' | 'company'; id: string } | null; expiresAt: string } = open;
  const step = (from: typeof buyer | typeof seller, to: typeof buyer | typeof seller, intent: Parameters<typeof agents.negotiationStep>[3]) => agents.negotiationStep(s, from, to, intent, at);
  let r = step(seller, buyer, 'propose');
  assert.deepEqual(r, { kind: 'apply', status: 'open', roundsUsed: 1, turn: buyer, escalate: null });
  s = { ...s, roundsUsed: 1, turn: buyer };
  assert.deepEqual(step(seller, buyer, 'counter'), { kind: 'refuse', reason: 'negotiation.not_your_turn' });
  assert.deepEqual(step(seller, buyer, 'accept'), { kind: 'refuse', reason: 'negotiation.not_your_turn' }, 'a party cannot accept its own proposal');
  r = step(buyer, seller, 'counter');
  assert.equal(r.kind === 'apply' && r.roundsUsed, 2);
  s = { ...s, roundsUsed: 3, turn: buyer };
  assert.deepEqual(step(buyer, seller, 'counter'), { kind: 'end', status: 'escalated', reason: 'rounds_exhausted' });
  assert.deepEqual(step(buyer, seller, 'accept'), { kind: 'apply', status: 'agreed_pending_confirmation', roundsUsed: 3, turn: null, escalate: 'agreement_needs_confirmation' });
  assert.deepEqual(step(buyer, seller, 'clarify'), { kind: 'apply', status: 'open', roundsUsed: 3, turn: buyer, escalate: null }, 'informational intents move nothing');
  assert.deepEqual(agents.negotiationStep({ ...s, expiresAt: '2026-10-01T00:00:00Z' }, buyer, seller, 'counter', at), { kind: 'end', status: 'expired', reason: 'expired' });
  assert.deepEqual(agents.negotiationStep({ ...s, status: 'declined' }, buyer, seller, 'counter', at), { kind: 'refuse', reason: 'negotiation.closed' });
});

test('the note guard finds private amounts written in any common form and ignores small numbers', () => {
  const amounts = ['9000000', '2800', '61300'];
  for (const note of ['budget 90,000.00', 'budget 90000', 'USD 90 000', 'floor 28.00', 'floor 2800', 'laying 613.00', 'laying 613']) assert.ok(agents.noteMentionsAmount(note, amounts), note);
  for (const note of ['delivery in 10 days', 'line q1 and q2', 'we need 28 pallets', 'call 555 0101', '']) assert.ok(!agents.noteMentionsAmount(note, amounts), note);
  assert.ok(!agents.noteMentionsAmount('12', ['12']), 'amounts below three digits are ignored');
});

test('goals never pre-authorize money or human-only verbs; commands are strict; a goal never names its own authority', () => {
  for (const action of catalog.MANDATE_ACTIONS_V2) assert.equal(agents.goalActionAllowed(action), !catalog.MONEY_ACTIONS.includes(action) && !catalog.HUMAN_ONLY_ACTIONS.includes(action), action);
  const need = { moduleKey: 'negotiation', actions: ['negotiate'], contexts: [{ kind: 'rfq', id: 'rfq-1' }], perWindow: null, approvalPolicy: { mode: 'ask_each' } };
  assert.ok(agents.GoalNeedSchema.safeParse(need).success);
  assert.ok(!agents.GoalNeedSchema.safeParse({ ...need, actions: ['release_payment'] }).success);
  assert.ok(!agents.GoalNeedSchema.safeParse({ ...need, actions: ['negotiate', 'negotiate'] }).success);
  const goal = { onBehalfOf: null, text: 'Find a supplier', successCriteria: ['One accepted quote'], needs: [need], budgetRange: null, horizon: '2027-01-01T00:00:00Z', reportCadence: 'weekly' };
  assert.ok(agents.CreateGoalCommandSchema.safeParse(goal).success);
  for (const extra of [{ status: 'active' }, { confirmation: { via: 'first_party_form' } }, { mandateIds: ['m'] }]) assert.ok(!agents.CreateGoalCommandSchema.safeParse({ ...goal, ...extra }).success, JSON.stringify(extra));
  assert.ok(!agents.CreateGoalCommandSchema.safeParse({ ...goal, budgetRange: { low: { minorUnits: '9', currency: 'USD' }, high: { minorUnits: '1', currency: 'USD' } } }).success);
  // A covering mandate must already authorize everything a need asks, for the whole horizon.
  const mandate = catalog.MandateV2Schema.parse({
    id: 'm1', schemaVersion: 2, principal: { personId: 'p', onBehalfOf: null }, grantee: { kind: 'own_agent' }, moduleKeys: ['negotiation'], actions: ['negotiate', 'communicate'], contexts: [{ kind: 'rfq', id: 'rfq-1' }],
    limits: { ceiling: null, perActionCeiling: null, transactionBudgetId: null, platformBudgetId: null, perWindow: null }, conditions: [], approvalPolicy: { mode: 'ask_each' }, approvers: [],
    escalation: { kind: 'ask_principal' }, confirmation: { via: 'first_party_form', personId: 'p', at: '2026-10-31T00:00:00Z', stepUp: true }, validUntil: '2027-06-01T00:00:00Z', status: 'active', revision: 1, revokedAt: null,
  });
  const n = agents.GoalNeedSchema.parse(need);
  assert.ok(mandateCoversNeed(mandate, n, null, new Date('2027-01-01T00:00:00Z')));
  assert.ok(!mandateCoversNeed(mandate, n, null, new Date('2027-07-01T00:00:00Z')), 'expires before the horizon');
  assert.ok(!mandateCoversNeed(mandate, { ...n, actions: ['introduce'] }, null, new Date('2027-01-01T00:00:00Z')));
  assert.ok(!mandateCoversNeed(mandate, n, 'company-1', new Date('2027-01-01T00:00:00Z')), 'a personal mandate never covers a company goal');
});

test('envelope commands: the sender is never accepted from the caller; every intent maps to a mandate verb', () => {
  const body = { actingAs: { kind: 'own_agent', mandateId: 'm1' }, to: person('p2'), context: { kind: 'rfq', id: 'r1' }, intent: 'clarify', refs: [], note: null, negotiationSessionId: null, expiresAt: '2026-11-05T00:00:00Z' };
  assert.ok(agents.SendEnvelopeCommandSchema.safeParse(body).success);
  for (const extra of [{ from: person('x') }, { actorKind: 'company_representative' }, { accountablePersonId: 'x' }, { mandateProof: {} }]) assert.ok(!agents.SendEnvelopeCommandSchema.safeParse({ ...body, ...extra }).success, JSON.stringify(extra));
  assert.ok(!agents.SendEnvelopeCommandSchema.safeParse({ ...body, context: { kind: 'project', id: 'x' } }).success, 'only verifiable contexts');
  assert.ok(!agents.SendEnvelopeCommandSchema.safeParse({ ...body, note: { text: 'x'.repeat(4001), locale: null } }).success);
  for (const intent of catalog.EnvelopeIntentSchema.options) assert.ok(catalog.MANDATE_ACTIONS_V2.includes(agents.ENVELOPE_INTENT_ACTION[intent]), intent);
  assert.ok(catalog.STATE_MOVING_INTENTS.every((i) => agents.NEGOTIATION_INTENTS.includes(i)));
  assert.ok(!agents.CompanyRepresentativeSchema.safeParse({ id: 'r', companyId: 'c', accountablePersonId: null, status: 'active', suspensionReason: null, blockedBy: null, labelKey: 'agents.label.representative', acceptedAt: null, revision: 1 }).success, 'an active representative has an accountable person');
});

test('every AGT-001 capability is valid, available to the interface and the agent, and mounted exactly once as a route', () => {
  const caps = agents.AGENT_CAPABILITIES.map((e) => e.capability);
  for (const cap of caps) {
    assert.deepEqual(catalog.capabilityViolations(cap), [], cap.id);
    if (cap.kind === 'govern') assert.ok(!cap.surfaces.includes('mcp') && !cap.surfaces.includes('a2a'), `${cap.id}: governance is never exposed to connections`);
    for (const r of [cap.input, cap.output]) {
      const mod = r.contract === 'agents' ? agents : catalog;
      assert.ok((mod as Record<string, unknown>)[r.schema], `${cap.id}: ${r.contract}.${r.schema} is exported`);
    }
  }
  assert.deepEqual(catalog.parityGaps(caps), []);
  assert.equal(new Set(caps.map((c) => c.id)).size, caps.length);
  const mounted = new Map<string, { idempotent: string | null; auth: string | null }>();
  for (const controller of [AgentsController, CompanyRepresentativeController]) {
    const base = Reflect.getMetadata(PATH_METADATA, controller) as string;
    for (const key of Object.getOwnPropertyNames(controller.prototype)) {
      const handler = (controller.prototype as unknown as Record<string, unknown>)[key];
      if (typeof handler !== 'function' || key === 'constructor') continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) === RequestMethod.POST ? 'POST' : 'GET';
      const path = `/${base}/${Reflect.getMetadata(PATH_METADATA, handler) as string}`.replace(/\/$/, '');
      const idempotent = (Reflect.getMetadata(IDEMPOTENT, handler) as { action: string } | undefined)?.action ?? null;
      mounted.set(`${method} ${path}`, { idempotent, auth: (Reflect.getMetadata(AUTH_REQUIREMENT, handler) as string | undefined) ?? null });
    }
  }
  const declared = new Set(agents.AGENT_CAPABILITIES.map((e) => e.apiRoute));
  assert.deepEqual([...mounted.keys()].sort(), [...declared].sort(), 'every route has a capability and every capability a route');
  for (const [route, meta] of mounted) {
    assert.ok(meta.auth, `${route} needs a session`);
    if (route.startsWith('POST')) assert.equal(IDEMPOTENT_ROUTES[meta.idempotent ?? '']?.kind, 'in_transaction', `${route} completes in its transaction`);
  }
  for (const entry of agents.AGENT_CAPABILITIES.filter((e) => e.capability.confirmation === 'first_party_step_up')) assert.equal(mounted.get(entry.apiRoute)?.auth, 'step_up', `${entry.capability.id} is step-up`);
});
