import { fakeGate, restrictedPlaces, type JurisdictionGate } from '../../../../packages/contracts/src/sanctions.js';
import { createHash } from 'node:crypto';
import { jurisdictionGate } from '../../../../packages/data/src/repositories/jurisdiction.js';
import { withMaintenance } from '@trustwork/data';
import { startHarness } from '../../../backend/helpers/app.js';
import { command } from '../../../admin/helpers.js';
import { login, seedPersonas } from '../../../backend/helpers/personas.js';
import { elevate, enrol } from '../../../backend/second-factor/helpers.js';
import { workerLogin } from '../../../assistant/helpers.js';
import { assignmentStaffRoles } from '../../../../apps/api/src/modules/identity/staff-roles.js';
import { adminSetup, staffRoleDefinitions } from '../../../../packages/data/src/repositories/admin.js';
import { activateList, CONS_ENTRIES, screen, SDN_ENTRIES } from '../../../screening/helpers.js';
import { syncKernel } from '../../../hubs/helpers.js';
import { baselineIds } from '../../../screening-lists/helpers.js';

/** Real PostgreSQL and role resolver; only people and list input are synthetic. No provider is called. */
export async function screeningWorld(label: string, publicOrigin = 'https://trustwork.test', options: { auditorSecond?: boolean; gate?: JurisdictionGate } = {}) {
  const h = await startHarness(label, { jurisdictionGate: options.gate ?? fakeGate(restrictedPlaces(['CU'])), staffRoles: assignmentStaffRoles({ hubId: null }), env: { API_HOST: '127.0.0.1', API_PORT: '0', PUBLIC_ORIGIN: publicOrigin, API_INSECURE_COOKIES: publicOrigin.startsWith('http:') ? '1' : '', API_TRUSTED_PROXY_HOPS: '1', AUTH_RATE_LIMIT_PER_MINUTE: '10000', AUTH_PROVIDER_MODE: 'fake', API_LOG_LEVEL: 'error' } });
  if (!h) throw new Error('SANC-006 requires PostgreSQL');
  const workers = await workerLogin(h);
  try {
    const seed = await seedPersonas(h);
    await syncKernel(h.db.admin);
    const node = await withMaintenance(h.db.admin, async (trx) => {
      const node = await adminSetup.createNode(trx, 'Synthetic screening node');
      await staffRoleDefinitions.release(trx, { version: 1, role: 'compliance-officer', scopes: ['node', 'hub'], permissions: ['admin.claims.read', 'admin.claims.decide', 'admin.hub.read', 'admin.staff.assign'], caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
      await staffRoleDefinitions.release(trx, { version: 1, role: 'moderator', scopes: ['node'], permissions: ['admin.hub.read'], caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
      if (options.auditorSecond) await staffRoleDefinitions.release(trx, { version: 1, role: 'auditor', scopes: ['node'], permissions: ['admin.audit.read', 'admin.hub.read'], caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
      await adminSetup.bootstrapFirstAdmin(trx, { personId: seed.people.anna, role: 'compliance-officer', scope: { kind: 'node', nodeId: node.id }, definitionVersion: 1, reason: 'Synthetic setup' });
      await adminSetup.bootstrapFirstAdmin(trx, { personId: seed.people.boris, role: options.auditorSecond ? 'auditor' : 'compliance-officer', scope: { kind: 'node', nodeId: node.id }, definitionVersion: 1, reason: 'Synthetic setup' });
      await trx.updateTable('screening_list').set({ min_entries: 1, max_drop_share: '0.99' }).where('baseline', '=', true).execute();
      await trx.updateTable('person').set({ display_name: 'Milo Fictivsky' }).where('id', '=', seed.people.petr).execute();
      return node;
    });
    const worker = workers.pool(4);
    const lists = await baselineIds(h.db.admin);
    await activateList(worker, lists.sdn, SDN_ENTRIES);
    await activateList(worker, lists.cons, CONS_ENTRIES);
    await screen(worker, { kind: 'person', id: seed.people.petr });
    await screen(worker, { kind: 'company', id: seed.companies.unrelated });
    const first = h.client(); const second = h.client(); const subject = h.client(); const unelevated = h.client(); const otherStaff = h.client();
    await login(otherStaff, 'xenia'); await login(unelevated, 'anna'); await login(first, 'anna'); await login(second, 'boris'); await login(subject, 'petr');
    const firstFactor = await enrol(h, first); const secondFactor = await enrol(h, second);
    await elevate(h, first, firstFactor.secret); await elevate(h, second, secondFactor.secret);
    // Only two founding administrators; the third test role uses the accepted assignment command.
    const assigned = await command(first, '/v1/admin/staff/assignments', { personId: seed.people.xenia, role: 'moderator', scope: { kind: 'node', nodeId: node.id }, definitionVersion: 1, reasonCode: 'staffing' });
    if (assigned.status !== 201) throw new Error(`Synthetic moderator assignment failed: ${assigned.status} ${JSON.stringify(assigned.body)}`);
    const otherFactor = await enrol(h, otherStaff); await elevate(h, otherStaff, otherFactor.secret);
    const hubId = await withMaintenance(h.db.admin, async (trx) => {
      const hub = await trx.insertInto('hub').values({ slug: 'synthetic-screening', lifecycle: 'draft', pack_code: null, pack_version: null }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('hub_profile').values({ hub_id: hub.id, node_id: node.id, name: { en: 'Synthetic screening hub' }, default_locale: 'en', locales: ['en'], time_zone: 'America/Los_Angeles', currency: 'USD', brand_overlay: null, created_by: seed.people.anna }).execute();
      await trx.insertInto('hub_territory').values({ hub_id: hub.id, level: 'country', code: 'US', place_key: null }).execute();
      return hub.id;
    });
    const held = h.client(); await login(held, 'carl');
    const token = [...held.jar].find(([key]) => key.endsWith('sr_session'))?.[1];
    if (!token) throw new Error('Synthetic hold session missing');
    await jurisdictionGate.holdSession(h.pool, { tokenHashHex: createHash('sha256').update(token).digest('hex'), place: 'CU', source: 'geolocation', dataset: 'synthetic-fake' });
    return { h, seed, node, hubId, worker, first, second, subject, unelevated, otherStaff, async close() { await workers.close(); await h.close(); } };
  } catch (error) { await workers.close(); await h.close(); throw error; }
}
