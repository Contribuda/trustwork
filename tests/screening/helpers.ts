import { randomBytes } from 'node:crypto';
import { withMaintenance, type DataPool, type Transaction } from '@trustwork/data';
import { listDigest, parseOfacSlsXml, renderOfacSlsXml, sourceDigest, type FakeListEntry } from '../../packages/compliance/src/lists/index.js';
import { checkListSanity, type ScreeningSubjectRef } from '../../packages/contracts/src/sanctions.js';
import { screeningListWorker } from '../../packages/data/src/repositories/screening-lists.js';
import { screenSubject } from '../../apps/worker/src/screening/index.js';
import type { ScreeningConfig } from '../../apps/worker/src/screening/config.js';
import { tx } from '../worker/helpers/worker-db.js';
import { baselineIds, complianceWorld } from '../screening-lists/helpers.js';

/**
 * Synthetic screening world for the SANC-003 suites. Every list entry and every person or company name here is
 * invented and labelled synthetic; none is, or is meant to resemble, a listed person or company.
 */
export const SDN_ENTRIES: FakeListEntry[] = [
  { uid: '920001', type: 'individual', firstName: 'Zorvan Q', lastName: 'EXAMPLETON', aliases: [{ firstName: 'Зорван', lastName: 'ЭКЗАМПЛТОН' }], programs: ['SYNTHETIC-A'], datesOfBirth: ['01 Jan 1971'] },
  { uid: '920002', type: 'individual', firstName: 'Milo', lastName: 'FICTIVSKY', programs: ['SYNTHETIC-B'] },
  { uid: '920003', type: 'entity', lastName: 'NORTHWIND SYNTHETIC SUPPLY LLC', programs: ['SYNTHETIC-C'] },
  { uid: '920004', type: 'individual', firstName: 'Orla', lastName: 'TESTWORTHY', programs: ['SYNTHETIC-A'] },
  { uid: '920005', type: 'vessel', lastName: 'NORTHWIND SYNTHETIC VOYAGER', programs: ['SYNTHETIC-C'] },
];
export const CONS_ENTRIES: FakeListEntry[] = [
  { uid: '930001', type: 'individual', firstName: 'Petra', lastName: 'SAMPLEWOOD', programs: ['SYNTHETIC-D'] },
];
export const CONFIG: ScreeningConfig = { fuzzyThreshold: null, vesselsAndAircraft: false, sweepBatch: 500 };

/** Stages and activates one version of a baseline list from synthetic entries on the worker role. */
export async function activateList(worker: DataPool, listId: string, entries: readonly FakeListEntry[], publishedOn = '2026-10-20'): Promise<string> {
  const parsed = parseOfacSlsXml(renderOfacSlsXml({ publishedOn, entries }));
  return tx(worker, async (trx) => {
    const locked = await screeningListWorker.lock(trx, listId);
    const sanity = checkListSanity({ parsedCount: parsed.entries.length, declaredCount: parsed.declaredCount, previousCount: locked?.active?.entryCount ?? null, maxDropShare: 0.99, minEntries: 1 });
    const versionId = await screeningListWorker.stage(trx, {
      listId, publishedOn: parsed.publishedOn, fetchedAt: new Date(), mode: 'file', sourceDigest: sourceDigest(listDigest(parsed.entries)), digest: listDigest(parsed.entries), sanity, entries: parsed.entries,
    });
    const outcome = await screeningListWorker.activate(trx, versionId);
    if (outcome !== 'activated') throw new Error(`list version not activated: ${outcome}`);
    return versionId;
  });
}

/** The compliance world of SANC-002 plus a third compliance officer (ops), and both baseline lists activated. */
export async function screeningWorld(admin: DataPool, runtime: DataPool, worker: DataPool) {
  const world = await complianceWorld(admin, runtime);
  await world.assignSensitive({ personId: world.w.people.ops, role: 'compliance-officer', scope: { kind: 'node', nodeId: world.w.nodeId } });
  const lists = await baselineIds(admin);
  await world.owner((trx) => trx.updateTable('screening_list').set({ min_entries: 1, max_drop_share: '0.99' }).where('baseline', '=', true).execute());
  const versions = { sdn: await activateList(worker, lists.sdn, SDN_ENTRIES), cons: await activateList(worker, lists.cons, CONS_ENTRIES) };
  return { ...world, lists, versions };
}

/** A synthetic person (with a live session) or company, created through the maintenance path. */
export async function person(admin: DataPool, name: string): Promise<{ id: string; sessionId: string; tokenHash: Buffer }> {
  return withMaintenance(admin, async (trx) => {
    const id = (await trx.insertInto('person').values({ display_name: name }).returning('id').executeTakeFirstOrThrow()).id;
    const tokenHash = randomBytes(32);
    const session = await trx.insertInto('session').values({ person_id: id, token_hash: tokenHash, idle_expires_at: new Date(Date.now() + 86_400_000), absolute_expires_at: new Date(Date.now() + 86_400_000), auth_method: 'password' })
      .returning('id').executeTakeFirstOrThrow();
    return { id, sessionId: session.id, tokenHash };
  });
}
export async function company(admin: DataPool, name: string, administrators: readonly string[] = []): Promise<string> {
  return withMaintenance(admin, async (trx) => {
    const id = (await trx.insertInto('company').values({ display_name: name, claim_status: 'claimed' }).returning('id').executeTakeFirstOrThrow()).id;
    for (const personId of administrators) {
      await trx.insertInto('membership').values({ person_id: personId, company_id: id, role: 'administrator', permissions: ['company.members.manage'], status: 'active', valid_from: new Date('2026-10-01T09:00:00Z') }).execute();
    }
    return id;
  });
}

/** One screening of a subject on the worker role (the job's transaction). */
export const screen = (worker: DataPool, subject: ScreeningSubjectRef, config: ScreeningConfig = CONFIG, trigger: 'registration' | 'sign_in' | 'name_change' | 'company_change' | 'scheduled' = 'registration') =>
  tx(worker, (trx) => screenSubject(trx, subject, trigger, config));

/** The owner's view of rows (tests only). */
export const ownerRows = <T>(admin: DataPool, fn: (trx: Transaction) => Promise<T>): Promise<T> => withMaintenance(admin, fn);
