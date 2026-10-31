import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { withMaintenance, withPrincipal, type DataPool, type Transaction } from '@trustwork/data';
import type { Client, Harness, Response } from '../backend/helpers/app.js';
import { principalFor } from '../data/helpers/seed.js';
import { computeDigest } from '../../packages/contracts/src/common/digest.js';
import type { Digest, Money } from '../../packages/contracts/src/client.js';
import { submitForApproval, type SubmitForApprovalInput } from '../../apps/api/src/modules/approval-routes/port.js';
import type { ApprovalSubjectFacts } from '../../apps/api/src/modules/approval-routes/resolution.js';
import { routeDigest } from '../../apps/api/src/modules/approval-routes/resolution.js';
import { approvalRoutes } from '../../packages/data/src/repositories/approval-routes.js';

/**
 * A synthetic construction company for the PRC-001 suites (every name is fictitious, every address example.invalid):
 * an administrator (routes manager and approver), a requester, two approvers holding procurement.approval.decide, a
 * delegate without rights, a project leader, a receiving clerk, plus an outsider of another company.
 */
export const PASSWORD = 'synthetic-approvals-password-0001';
export const PEOPLE = ['ada', 'rita', 'paul', 'quinn', 'dana', 'lena', 'carlos', 'otto'] as const;
export type Person = (typeof PEOPLE)[number];
export const email = (p: Person) => `approvals-${p}@example.invalid`;

export interface World {
  company: string;
  otherCompany: string;
  project: string;
  people: Record<Person, string>;
  sessions: Record<Person, string>;
}

export const usd = (minorUnits: string): Money => ({ minorUnits, currency: 'USD' });
export const uuid = (): string => crypto.randomUUID();
export const subjectDigest = (label: string): Digest => computeDigest({ synthetic: 'approval-subject', label });

export async function grant(admin: DataPool, w: World, person: Person, action: string, projectId: string | null = null): Promise<string> {
  const scope = projectId ? { companyId: w.company, projectId } : { companyId: w.company };
  return withMaintenance(admin, async (trx) => (await trx.insertInto('permission_grant').values({ principal_person_id: w.people[person], action, scope: JSON.stringify(scope), granted_by: w.people.ada }).returning('id').executeTakeFirstOrThrow()).id);
}

export async function seedWorld(h: Harness, label: string): Promise<World> {
  const passwordHash = await hash(PASSWORD, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
  return withMaintenance(h.db.admin, async (trx) => {
    const company = (await trx.insertInto('company').values({ display_name: `Synthetic Builders ${label} LLC`, claim_status: 'claimed' }).returning('id').executeTakeFirstOrThrow()).id;
    const otherCompany = (await trx.insertInto('company').values({ display_name: `Synthetic Elsewhere ${label} LLC`, claim_status: 'claimed' }).returning('id').executeTakeFirstOrThrow()).id;
    const people = {} as Record<Person, string>;
    const sessions = {} as Record<Person, string>;
    for (const p of PEOPLE) {
      const id = (await trx.insertInto('person').values({ display_name: `Synthetic ${p} ${label}`, profile_visibility: 'private' }).returning('id').executeTakeFirstOrThrow()).id;
      people[p] = id;
      await trx.insertInto('email_binding').values({ person_id: id, email_normalized: email(p).replace('@', `-${label}@`), is_primary: true, verified_at: new Date('2026-10-01T09:00:00Z') }).execute();
      await trx.insertInto('credential').values({ person_id: id, kind: 'password', password_hash: passwordHash }).execute();
      sessions[p] = (await trx.insertInto('session').values({ person_id: id, token_hash: randomBytes(32), idle_expires_at: new Date(Date.now() + 86_400_000), absolute_expires_at: new Date(Date.now() + 86_400_000), auth_method: 'password' }).returning('id').executeTakeFirstOrThrow()).id;
      await trx.insertInto('membership').values({
        person_id: id, company_id: p === 'otto' ? otherCompany : company, role: p === 'ada' || p === 'otto' ? 'administrator' : 'member',
        permissions: p === 'ada' || p === 'otto' ? ['company.members.manage'] : [], status: 'active', valid_from: new Date('2026-10-01T09:00:00Z'),
      }).execute();
    }
    const project = (await trx.insertInto('project').values({ owner_company_id: company, creator_person_id: people.ada, leader_person_id: people.lena, name: `Synthetic Riverside ${label}`, summary: null }).returning('id').executeTakeFirstOrThrow()).id;
    return { company, otherCompany, project, people, sessions };
  });
}

export function loginEmail(p: Person, label: string): string {
  return email(p).replace('@', `-${label}@`);
}
export async function signIn(h: Harness, p: Person, label: string): Promise<Client> {
  const client = h.client();
  const response = await client.post('/v1/auth/login', { email: loginEmail(p, label), password: PASSWORD }, { idempotencyKey: null });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return client;
}

export async function as<T>(h: Harness, w: World, p: Person, fn: (trx: Transaction) => Promise<T>): Promise<T> {
  return withPrincipal(h.pool, await principalFor(h.db.admin, w.people[p]), fn);
}

/** Drafts and activates a route version through the repository, as the given route manager in their session. */
export async function activeRoute(h: Harness, w: World, subjectKind: Parameters<typeof routeDigest>[0]['subjectKind'], payload: Parameters<typeof routeDigest>[0]['payload'], manager: Person = 'ada'): Promise<string> {
  const digest = routeDigest({ ownerCompanyId: w.company, subjectKind, payload, templateKey: null, templateVersion: null }).value;
  const draft = await as(h, w, manager, (trx) => approvalRoutes.draft(trx, { companyId: w.company, subjectKind, payload, digest, templateKey: null, templateVersion: null, secondPersonRequired: false }));
  const active = await as(h, w, manager, (trx) => approvalRoutes.activate(trx, { routeId: draft.id, digest, expectedRevision: draft.revision, sessionId: w.sessions[manager] }));
  return active.id;
}

export async function submit(h: Harness, w: World, p: Person, input: Omit<SubmitForApprovalInput, 'companyId' | 'facts'> & { facts?: Partial<ApprovalSubjectFacts> }, now = new Date()) {
  return as(h, w, p, (trx) => submitForApproval(trx, { companyId: w.company, facts: {}, ...input }, now));
}

/** A permission-holders step with the defaults of most tests. */
export const holders = (key: string, over: Record<string, unknown> = {}) => ({
  key, order: 1, conditions: [], selector: { kind: 'permission_holders', permission: 'procurement.approval.decide', scope: 'company' }, quorum: 1, timeoutHours: 48, escalation: { kind: 'route_owner' }, ...over,
});

export function ok<T>(r: Response, status = 200): T {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body as T;
}

interface PgError { code?: string; hint?: string; message?: string; detail?: string; details?: { reason?: string } }
/** Expects a database hint or code (or the API reason `approvals.<reason>` of a mapped refusal). */
export async function fails(promise: Promise<unknown>, expected: string, detail?: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const e = error as PgError;
    const reason = e.details?.reason ? `approvals.${e.details.reason}` : null;
    assert.ok(e.hint === expected || e.code === expected || reason === expected, `expected ${expected}, got ${e.code} ${e.hint ?? ''} ${reason ?? ''} ${e.message ?? ''}`);
    if (detail !== undefined) assert.equal(e.detail, detail);
    return;
  }
  assert.fail(`expected ${expected}, but it succeeded`);
}
