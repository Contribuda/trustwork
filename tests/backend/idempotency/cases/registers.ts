import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { HUB_CONSOLE_CONTRACT_VERSION } from '@trustwork/contracts';
import { withMaintenance } from '@trustwork/data';
import type { CrashCase } from '../cases.js';
import type { Client, Response } from '../../helpers/app.js';
import { count } from '../../hardening/helpers.js';
import { codeNow } from '../../second-factor/helpers.js';
import { addLogins, enrolNow, PASSWORD, signIn } from '../../../admin/helpers.js';

/** Test role definition over the console vocabulary (version 29, unused elsewhere), held at this case's own hub. */
const VERSION = 29;
const PERMISSIONS = ['admin.sources.read', 'admin.sources.manage', 'admin.sources.dedupe.decide', 'admin.providers.toggle'];
const USES = {
  displayHeadlineAndLink: true, displaySummary: true, storeFullText: false, indexForSearch: true, sendToModelProviders: false, translate: false, rewriteWithAttribution: false,
  reuseImages: false, syndicateToPeers: false,
};

/**
 * REG-001: every registers route classified in_transaction, through the BE-005 crash sequence. Steward A binds adapters
 * to two synthetic official-register sources (seeded active through the maintenance path, activated by steward B),
 * runs the fakes, links an inspection record to a company, ends the link, takes the LEI adapter live under steward B's
 * approval and retires the licence adapter. Every person, hub, company, identifier and source is synthetic.
 */
export default {
  name: 'REG-001: register adapters, fake runs and reviewed links',
  async run({ h, exactlyOnce }) {
    const admin = h.db.admin;
    const hubId = '00000000-0000-4000-8000-00000000c910';
    const seeded = await withMaintenance(admin, async (trx) => {
      await trx.insertInto('hub').values({ id: hubId, slug: `synthetic-registers-${randomBytes(2).toString('hex')}`, lifecycle: 'public' }).execute();
      // The hub is in full mode, so the second person acts through a different role, with the same permissions here.
      for (const role of ['data-steward', 'editor-in-chief'] as const) {
        await trx.insertInto('staff_role_definition_version').values({ role, version: VERSION, scopes: ['hub'], permissions: PERMISSIONS, grant_max_hours: 72, sod_mode: 'reduced' })
          .onConflict((oc) => oc.doNothing()).execute();
      }
      const founder = await trx.selectFrom('staff_role_assignment').select('person_id').where('setup_bootstrap', '=', true).where('role', '=', 'platform-owner').executeTakeFirstOrThrow();
      const person = async (name: string) => (await trx.insertInto('person').values({ display_name: name }).returning('id').executeTakeFirstOrThrow()).id;
      const out = { a: await person('Synthetic Crash Registers Steward A'), b: await person('Synthetic Crash Registers Steward B') };
      for (const [id, role] of [[out.a, 'data-steward'], [out.b, 'editor-in-chief']] as const) {
        await trx.insertInto('staff_role_assignment').values({ person_id: id, role, scope_kind: 'hub', hub_id: hubId, definition_version: VERSION, granted_by: founder.person_id, reason: 'Synthetic crash test' }).execute();
      }
      const source = async (name: string) => (await trx.insertInto('source').values({
        hub_id: hubId, kind: 'register_open_data', name, url: 'https://register.synthetic-crash.invalid/data', reader_kind: 'official_register', purposes: ['company_directory'],
        licence_kind: 'statutory_public', allowed_uses: JSON.stringify(USES), attribution_template: `Source: ${name}`, takedown_contact: 'records@synthetic-crash.invalid',
        owner_person_id: out.a, personal_data: false, proposed_by_person: out.a, edited_by: out.a, status: 'active', activated_by: out.b, activated_at: new Date(),
      } as never).returning('id').executeTakeFirstOrThrow()).id;
      const companyId = (await trx.insertInto('company').values({ display_name: 'Synthetic Crash Registers Builders', claim_status: 'claimed' } as never).returning('id').executeTakeFirstOrThrow()).id;
      const credentialId = (await trx.insertInto('provider_credential_ref').values({ hub_id: hubId, provider: 'synthetic_gleif', adapter: 'gleif_lei', mode: 'live', secret_store: 'env',
        secret_ref: 'env:SYNTHETIC_CRASH_GLEIF', registered_by: out.a }).returning('id').executeTakeFirstOrThrow()).id;
      return { people: out, licenceSource: await source('Synthetic Crash Licence Board'), indexSource: await source('Synthetic Crash LEI Index'),
        inspectionSource: await source('Synthetic Crash Inspections'), companyId, credentialId };
    });
    const { people, companyId, credentialId } = seeded;
    const email = (k: string) => `crash-registers-${k}@example.invalid`;
    await addLogins(h, Object.entries(people).map(([k, id]) => [id, email(k)]));
    const clients = {} as Record<'a' | 'b', Client>;
    for (const key of ['a', 'b'] as const) {
      h.staff.set(people[key], [key === 'a' ? 'data-steward' : 'editor-in-chief']);
      clients[key] = h.client();
      await signIn(clients[key], email(key));
      const secret = await enrolNow(h, clients[key]);
      h.clock.advance(30_000);
      assert.equal((await clients[key].post('/v1/auth/step-up', { password: PASSWORD }, { idempotencyKey: null })).status, 200);
      const elevated = await clients[key].post('/v1/admin/session/elevate', { proof: { method: 'totp', code: codeNow(h, secret) } }, { idempotencyKey: null });
      assert.equal(elevated.status, 200, `elevate ${key}: ${JSON.stringify(elevated.body)}`);
      h.clock.reset();
    }
    const { a, b } = clients;
    const body = <T>(r: Response): T => { assert.ok(r.status >= 200 && r.status < 300, JSON.stringify(r.body)); return r.body as T; };
    const cmd = (action: string, rest: Record<string, unknown>) => ({ contractVersion: HUB_CONSOLE_CONTRACT_VERSION, idempotencyKey: `crash-${action}`, reason: 'Synthetic crash test', ...rest });
    const run = (action: string, client: Client, url: string, rest: Record<string, unknown>, effects: () => Promise<number>) => exactlyOnce({ action, client, url, body: cmd(action, rest), effects });
    const audits = (action: string, objectId?: string) => () => count(admin, `SELECT 1 FROM trustwork.admin_audit_event WHERE action = $1 AND outcome = 'applied' AND hub_id = $2${objectId ? ' AND object_id = $3' : ''}`, objectId ? [action, hubId, objectId] : [action, hubId]);
    const base = `/v1/admin/hubs/${hubId}/registers`;
    type AdapterBody = { adapter: { id: string; revision: number } };

    const licence = body<AdapterBody>(await run('registers.adapter_bind', a, `${base}/adapters`, { adapter: 'us_ca_cslb_licence_file', sourceId: seeded.licenceSource, refreshDays: 7 },
      () => count(admin, 'SELECT 1 FROM trustwork.register_adapter WHERE hub_id = $1', [hubId])));
    await run('registers.fake_run', a, `${base}/adapters/${licence.adapter.id}/fake-runs`, { subjects: [{ identifierValue: '9000001' }] },
      () => count(admin, 'SELECT 1 FROM trustwork.register_fact WHERE adapter_id = $1', [licence.adapter.id]));

    const inspections = body<AdapterBody>(await a.post(`${base}/adapters`, cmd('registers.adapter_bind_osha', { adapter: 'us_osha_inspections', sourceId: seeded.inspectionSource, refreshDays: 30 }),
      { idempotencyKey: 'crash-registers.adapter_bind_osha' }));
    body(await a.post(`${base}/adapters/${inspections.adapter.id}/fake-runs`, cmd('registers.fake_run_osha', { subjects: [{ identifierValue: null, recordRef: 'SYN-CRASH-OSHA-1' }] }),
      { idempotencyKey: 'crash-registers.fake_run_osha' }));
    const linked = body<{ link: { id: string } }>(await run('registers.link_record', a, `${base}/links`, {
      adapterId: inspections.adapter.id, recordRef: 'SYN-CRASH-OSHA-1', companyId, reason: 'Establishment and address match the synthetic claim file.',
    }, () => count(admin, 'SELECT 1 FROM trustwork.register_fact_link WHERE hub_id = $1', [hubId])));
    await run('registers.link_end', b, `${base}/links/${linked.link.id}/end`, {}, audits('registers.link_ended', linked.link.id));

    // Live mode: steward A asks, steward B approves the exact digest, steward A takes the LEI adapter live.
    const lei = body<AdapterBody>(await a.post(`${base}/adapters`, cmd('registers.adapter_bind_lei', { adapter: 'gleif_lei', sourceId: seeded.indexSource, refreshDays: 30 }),
      { idempotencyKey: 'crash-registers.adapter_bind_lei' }));
    const digest = body<{ actionDigest: string }>(await a.get(`${base}/adapters/${lei.adapter.id}/live-digest?credentialRefId=${credentialId}`)).actionDigest;
    const requested = body<{ approval: { id: string } }>(await a.post('/v1/admin/approvals', { contractVersion: HUB_CONSOLE_CONTRACT_VERSION, idempotencyKey: 'crash-registers-approval',
      reason: 'Synthetic crash test', subject: { action: 'providers.enable_non_fake', scope: { kind: 'hub', hubId }, actionDigest: digest } }, { idempotencyKey: 'crash-registers-approval' }));
    body(await b.post(`/v1/admin/approvals/${requested.approval.id}/approve`, { contractVersion: HUB_CONSOLE_CONTRACT_VERSION, idempotencyKey: 'crash-registers-approve', reason: 'Synthetic crash test',
      actionDigest: digest }, { idempotencyKey: 'crash-registers-approve' }));
    await run('registers.adapter_live', a, `${base}/adapters/${lei.adapter.id}/live`, { expectedRevision: lei.adapter.revision, credentialRefId: credentialId, approvalId: requested.approval.id },
      audits('registers.adapter_live', lei.adapter.id));

    await run('registers.adapter_retire', a, `${base}/adapters/${licence.adapter.id}/retire`, { expectedRevision: licence.adapter.revision }, audits('registers.adapter_retired', licence.adapter.id));
  },
} satisfies CrashCase;
