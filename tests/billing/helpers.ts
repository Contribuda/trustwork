import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withMaintenance, withPrincipal, type DataPool, type Principal, type Transaction } from '@trustwork/data';
import { principalFor } from '../data/helpers/seed.js';
import { sqlState } from '../data/helpers/postgres.js';

/**
 * Synthetic billing world for the BILL-001 suites: a company with members holding different permissions, people
 * without an employer, and hub staff who draft and activate prices. Every name is synthetic (no real person or
 * company) and the demo hub id is a random UUID because the hub table arrives with DATA-003.
 */
export interface BillingWorld {
  hubId: string;
  company: string;
  otherCompany: string;
  people: {
    admin: string; // company.billing.manage + company.billing.view + company.deals.manage
    estimator: string; // company.deals.manage only (transaction authority, no platform authority)
    viewer: string; // company.billing.view only
    member: string; // no permissions
    outsider: string; // admin of the other company
    solo: string; // person without an employer
    solo2: string;
    drafter: string; // hub staff
    activator: string; // hub staff
  };
  project: string; // owned by the company
  soloProject: string; // owned by solo
}

export async function buildWorld(admin: DataPool): Promise<BillingWorld> {
  return withMaintenance(admin, async (trx) => {
    const person = async (name: string) => (await trx.insertInto('person').values({ display_name: name }).returningAll().executeTakeFirstOrThrow()).id;
    const company = async (name: string) => (await trx.insertInto('company').values({ display_name: name, claim_status: 'unclaimed' }).returningAll().executeTakeFirstOrThrow()).id;
    const companyId = await company('Synthetic Billing Builders LLC');
    const otherCompanyId = await company('Synthetic Other Supplies LLC');
    const people = {
      admin: await person('Synthetic Billing Admin'), estimator: await person('Synthetic Estimator'), viewer: await person('Synthetic Billing Viewer'),
      member: await person('Synthetic Plain Member'), outsider: await person('Synthetic Outsider'), solo: await person('Synthetic Solo Person'), solo2: await person('Synthetic Second Person'),
      drafter: await person('Synthetic Hub Drafter'), activator: await person('Synthetic Hub Activator'),
    };
    const member = async (personId: string, companyRef: string, role: 'member' | 'administrator', permissions: string[]) => {
      await trx.insertInto('membership').values({ person_id: personId, company_id: companyRef, role, permissions, status: 'active', valid_from: new Date('2026-10-01T09:00:00Z') }).execute();
    };
    await member(people.admin, companyId, 'administrator', ['company.members.manage', 'company.billing.manage', 'company.billing.view', 'company.deals.manage']);
    await member(people.estimator, companyId, 'member', ['company.deals.manage']);
    await member(people.viewer, companyId, 'member', ['company.billing.view']);
    await member(people.member, companyId, 'member', []);
    await member(people.outsider, otherCompanyId, 'administrator', ['company.members.manage', 'company.billing.manage', 'company.billing.view', 'company.deals.manage']);
    const project = await trx.insertInto('project').values({ owner_company_id: companyId, creator_person_id: people.admin, name: 'Synthetic warehouse fit-out' }).returning('id').executeTakeFirstOrThrow();
    const soloProject = await trx.insertInto('project').values({ owner_person_id: people.solo, creator_person_id: people.solo, name: 'Synthetic house extension' }).returning('id').executeTakeFirstOrThrow();
    return { hubId: randomUUID(), company: companyId, otherCompany: otherCompanyId, people, project: project.id, soloProject: soloProject.id };
  });
}

export function actor(admin: DataPool, runtime: DataPool) {
  const principal = (personId: string): Promise<Principal> => principalFor(admin, personId);
  return {
    principal,
    as: async <T>(personId: string, fn: (trx: Transaction) => Promise<T>): Promise<T> => withPrincipal(runtime, await principal(personId), fn),
    owner: <T>(fn: (trx: Transaction) => Promise<T>): Promise<T> => withMaintenance(admin, fn),
  };
}

interface PgError { code?: string; hint?: string; message?: string; details?: { reason?: string } }
export async function settle(promise: Promise<unknown>): Promise<PgError | null> {
  return promise.then(() => null, (e: unknown) => e as PgError);
}
/** Asserts a database refusal with SQLSTATE and (optionally) hint. */
export async function rejects(promise: Promise<unknown>, state: string, hint?: string): Promise<void> {
  const error = await settle(promise);
  assert.ok(error, `expected a rejection${hint ? ` (${hint})` : ''}`);
  assert.equal(sqlState(error), state, `${error.message} (hint ${error.hint})`);
  if (hint) assert.equal(error.hint, hint, error.message);
}
export const inSeconds = (s: number) => new Date(Date.now() + s * 1000);
export const days = (n: number) => new Date(Date.now() + n * 86_400_000);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
