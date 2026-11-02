import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { HUB_CONSOLE_CONTRACT_VERSION } from '@trustwork/contracts';
import { withMaintenance } from '@trustwork/data';
import type { CrashCase } from '../cases.js';
import type { Client, Response } from '../../helpers/app.js';
import { count } from '../../hardening/helpers.js';
import { codeNow } from '../../second-factor/helpers.js';
import { addLogins, enrolNow, PASSWORD, signIn } from '../../../admin/helpers.js';

/** Test role definition over the console vocabulary (version 30, unused elsewhere), held at this case's own hub. */
const VERSION = 30;
const PERMISSIONS = ['admin.sources.read', 'admin.datasets.read', 'admin.datasets.edit', 'admin.datasets.activate', 'admin.links.decide'];
const USES = {
  displayHeadlineAndLink: true, displaySummary: true, storeFullText: false, indexForSearch: true, sendToModelProviders: false, translate: false, rewriteWithAttribution: false,
  reuseImages: false, syndicateToPeers: false,
};

/**
 * MINE-001: every datasets route classified in_transaction, through the BE-005 crash sequence. Steward A proposes a
 * contract dataset, records its licence, allows contact use, ingests a record, marks it as a contact point, runs the
 * resolver, proposes a link, adds a do-not-collect entry and pauses the dataset; steward B activates it, decides the
 * proposal, decides a batch and marks a pair distinct. Every person, hub, company, record and source is synthetic.
 */
export default {
  name: 'MINE-001: datasets, licences, records, do-not-collect and entity resolution',
  async run({ h, exactlyOnce }) {
    const admin = h.db.admin;
    const hubId = '00000000-0000-4000-8000-00000000c920';
    const seeded = await withMaintenance(admin, async (trx) => {
      await trx.insertInto('hub').values({ id: hubId, slug: `synthetic-datasets-${randomBytes(2).toString('hex')}`, lifecycle: 'public' }).execute();
      await trx.insertInto('staff_role_definition_version').values({ role: 'data-steward', version: VERSION, scopes: ['hub'], permissions: PERMISSIONS, grant_max_hours: 72, sod_mode: 'reduced' })
        .onConflict((oc) => oc.doNothing()).execute();
      const founder = await trx.selectFrom('staff_role_assignment').select('person_id').where('setup_bootstrap', '=', true).where('role', '=', 'platform-owner').executeTakeFirstOrThrow();
      const person = async (name: string) => (await trx.insertInto('person').values({ display_name: name }).returning('id').executeTakeFirstOrThrow()).id;
      const out = { a: await person('Synthetic Crash Datasets Steward A'), b: await person('Synthetic Crash Datasets Steward B') };
      for (const id of [out.a, out.b]) {
        await trx.insertInto('staff_role_assignment').values({ person_id: id, role: 'data-steward', scope_kind: 'hub', hub_id: hubId, definition_version: VERSION, granted_by: founder.person_id, reason: 'Synthetic crash test' }).execute();
      }
      const sourceId = (await trx.insertInto('source').values({
        hub_id: hubId, kind: 'register_open_data', name: 'Synthetic Crash Business Register', url: 'https://register.synthetic-crash.invalid/data', reader_kind: 'official_register',
        purposes: ['company_directory'], licence_kind: 'statutory_public', allowed_uses: JSON.stringify(USES), attribution_template: 'Source: Synthetic Crash Business Register',
        takedown_contact: 'records@synthetic-crash.invalid', owner_person_id: out.a, personal_data: false, proposed_by_person: out.a, edited_by: out.a, status: 'active',
        activated_by: out.b, activated_at: new Date(),
      } as never).returning('id').executeTakeFirstOrThrow()).id;
      const company = async (name: string, identifiers: unknown[]) => (await trx.insertInto('company').values({ display_name: name, claim_status: 'unclaimed',
        legal_identifiers: JSON.stringify(identifiers) } as never).returning('id').executeTakeFirstOrThrow()).id;
      return {
        people: out, sourceId,
        holder: await company('Synthetic Crash Holder', [{ kind: 'US-CA-SOS', value: '9100001', status: 'sourced' }]),
        similar: await company('Synthetic Crash Similar', []),
        distinct: await company('Synthetic Crash Distinct', []),
      };
    });
    const { people } = seeded;
    const email = (k: string) => `crash-datasets-${k}@example.invalid`;
    await addLogins(h, Object.entries(people).map(([k, id]) => [id, email(k)]));
    const clients = {} as Record<'a' | 'b', Client>;
    for (const key of ['a', 'b'] as const) {
      h.staff.set(people[key], ['data-steward']);
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
    const base = `/v1/admin/hubs/${hubId}/datasets`;
    const today = new Date().toISOString().slice(0, 10);
    const later = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

    type DatasetBody = { dataset: { id: string; revision: number } };
    const proposed = body<DatasetBody>(await run('datasets.propose', a, base, {
      subject: 'companies', name: 'Synthetic crash operator list', sourceIds: [seeded.sourceId], purpose: 'Companies of the region for the directory and claim checks.',
      legalBasis: 'contract', personalData: { present: false, naturalPersons: false, categories: [] }, impactAssessmentRef: null, retention: { className: 'operator_list', days: 365 },
      outputs: ['directory_sourced_records'], publicDisplay: true, subjectNotice: false, refreshScheduleId: null,
    }, () => count(admin, 'SELECT 1 FROM trustwork.dataset WHERE hub_id = $1', [hubId])));
    const datasetId = proposed.dataset.id;
    await run('datasets.licence', a, `${base}/${datasetId}/licences`, {
      supplier: 'Synthetic Crash Supplier', agreementDigest: 'b'.repeat(64), agreementRef: 'agreement:SYN-CRASH', purposes: ['directory_sourced_records'],
      uses: { display: true, enrich: true, contactUse: true, syndicate: false }, validFrom: today, validUntil: later,
    }, () => count(admin, 'SELECT 1 FROM trustwork.dataset_licence WHERE dataset_id = $1', [datasetId]));
    const active = body<DatasetBody>(await run('datasets.activate', b, `${base}/${datasetId}/activate`, { expectedRevision: proposed.dataset.revision, approvalId: null },
      audits('datasets.activated', datasetId)));
    const allowed = body<DatasetBody>(await run('datasets.contact_use', a, `${base}/${datasetId}/contact-use`, { expectedRevision: active.dataset.revision, allowed: true },
      audits('datasets.contact_use_set', datasetId)));
    await run('datasets.ingest', a, `${base}/${datasetId}/records`, { records: [{
      sourceId: seeded.sourceId, externalKey: 'SYN-CRASH-1', identifierKind: 'US-CA-SOS', identifierValue: '9100001', naturalPerson: false,
      fields: { legalName: 'Synthetic Crash Holder', status: 'active' }, sourceUrl: 'https://register.synthetic-crash.invalid/entity/SYN-CRASH-1', method: 'structured_feed',
    }] }, () => count(admin, 'SELECT 1 FROM trustwork.dataset_record WHERE dataset_id = $1', [datasetId]));
    const recordId = (await admin.query<{ id: string }>('SELECT id FROM trustwork.dataset_record WHERE dataset_id = $1', [datasetId])).rows[0]!.id;
    await run('datasets.mark_contact', a, `${base}/records/${recordId}/contact`, { allowed: true }, audits('datasets.contact_marked', recordId));
    await run('datasets.resolve', a, `${base}/${datasetId}/resolve`, {}, () => count(admin, "SELECT 1 FROM trustwork.entity_link_proposal WHERE dataset_id = $1 AND proposed_by_kind = 'resolver'", [datasetId]));
    const proposal = body<{ proposal: { id: string; revision: number } }>(await run('datasets.link_propose', a, `${base}/links`, {
      recordId, targetKind: 'company', targetId: seeded.similar, evidence: [{ kind: 'name_address_similarity', detail: 'Similar name', similarity: '0.6' }], confidence: '0.6',
    }, () => count(admin, "SELECT 1 FROM trustwork.entity_link_proposal WHERE dataset_id = $1 AND proposed_by_kind = 'person'", [datasetId])));
    await run('datasets.link_decide', b, `${base}/links/${proposal.proposal.id}/decide`, { expectedRevision: proposal.proposal.revision, decision: 'rejected' },
      audits('datasets.link_rejected', proposal.proposal.id));
    const resolverProposal = (await admin.query<{ id: string }>("SELECT id FROM trustwork.entity_link_proposal WHERE dataset_id = $1 AND proposed_by_kind = 'resolver'", [datasetId])).rows[0]!.id;
    await run('datasets.link_batch', b, `${base}/links/batch`, { proposalIds: [resolverProposal], sampleIds: [resolverProposal], decision: 'accepted' },
      () => count(admin, 'SELECT 1 FROM trustwork.entity_link_batch WHERE hub_id = $1', [hubId]));
    await run('datasets.mark_distinct', b, `${base}/links/distinct`, { recordId, targetKind: 'company', targetId: seeded.distinct, distinctReason: 'A different company with a similar name.' },
      () => count(admin, 'SELECT 1 FROM trustwork.entity_distinct_pair WHERE hub_id = $1', [hubId]));
    await run('datasets.do_not_collect', a, `${base}/do-not-collect`, { kind: 'domain', value: 'objector.synthetic-crash.invalid', entryReason: 'objection' },
      () => count(admin, 'SELECT 1 FROM trustwork.dataset_do_not_collect WHERE hub_id = $1', [hubId]));
    await run('datasets.status', a, `${base}/${datasetId}/status`, { expectedRevision: allowed.dataset.revision, to: 'paused' }, audits('datasets.paused', datasetId));
  },
} satisfies CrashCase;
