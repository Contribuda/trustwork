// Named to sort before communications.ts: CNT-001 releases editorial role definitions at version 1, which the
// communications case would otherwise have taken for its own `editor` definition.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { HUB_CONSOLE_CONTRACT_VERSION } from '@trustwork/contracts';
import { withMaintenance } from '@trustwork/data';
import type { CrashCase } from '../cases.js';
import type { Client, Response } from '../../helpers/app.js';
import { auditCount, count } from '../../hardening/helpers.js';
import { codeNow } from '../../second-factor/helpers.js';
import { addLogins, enrolNow, PASSWORD, signIn } from '../../../admin/helpers.js';
import { releaseContentDefinitions, seedTopics } from '../../../content/helpers.js';

/**
 * CNT-001: every content route classified in_transaction, through the BE-005 crash sequence. Runs after the ADM-001
 * case, whose founding platform owner grants the synthetic editor-in-chief role here (maintenance path, as the setup
 * wizard would; the database still checks the grantor's permission). The harness's injected staff roles admit the
 * editor to staff routes; the database authorizes from staff_role_assignment for this case's own hub.
 */
export default {
  name: 'CNT-001: publications, walls, comments, issues, renders and digests',
  async run({ h, exactlyOnce }) {
    const admin = h.db.admin;
    const hubId = '00000000-0000-4000-8000-00000000c001';
    const previousHub = process.env.TRUSTWORK_HUB_ID;
    process.env.TRUSTWORK_HUB_ID = hubId;
    process.env.TRUSTWORK_CONTENT_COMMENTS = 'on';
    try {
      const people = await withMaintenance(admin, async (trx) => {
        await trx.insertInto('hub').values({ id: hubId, slug: `synthetic-cnt-${randomBytes(2).toString('hex')}`, lifecycle: 'public' }).execute();
        await releaseContentDefinitions(trx);
        await seedTopics(trx);
        const person = async (name: string) => (await trx.insertInto('person').values({ display_name: name }).returning('id').executeTakeFirstOrThrow()).id;
        const out = { writer: await person('Synthetic Crash Writer'), coauthor: await person('Synthetic Crash Co-author'), chief: await person('Synthetic Crash Editor-in-Chief') };
        const founder = await trx.selectFrom('staff_role_assignment').select('person_id').where('setup_bootstrap', '=', true).where('role', '=', 'platform-owner').executeTakeFirstOrThrow();
        await trx.insertInto('staff_role_assignment').values({ person_id: out.chief, role: 'editor-in-chief', scope_kind: 'hub', hub_id: hubId, definition_version: 1, granted_by: founder.person_id, reason: 'Synthetic crash test' }).execute();
        return out;
      });
      const email = (k: string) => `crash-content-${k}@example.invalid`;
      await addLogins(h, Object.entries(people).map(([k, id]) => [id, email(k)]));
      h.staff.set(people.chief, ['editor-in-chief']);
      const client = async (k: keyof typeof people) => { const c = h.client(); await signIn(c, email(k)); return c; };
      const writer = await client('writer');
      const coauthor = await client('coauthor');
      const chief = await client('chief');
      const secret = await enrolNow(h, chief);
      h.clock.advance(30_000);
      assert.equal((await chief.post('/v1/auth/step-up', { password: PASSWORD }, { idempotencyKey: null })).status, 200);
      const elevated = await chief.post('/v1/admin/session/elevate', { proof: { method: 'totp', code: codeNow(h, secret) } }, { idempotencyKey: null });
      assert.equal(elevated.status, 200, JSON.stringify(elevated.body));
      h.clock.reset();

      type View = { publication: { id: string; revision: number }; editions: { id: string }[] };
      const body = <T>(r: Response): T => { assert.ok(r.status >= 200 && r.status < 300, JSON.stringify(r.body)); return r.body as T; };
      const draft = (title: string, language = 'en') => ({ title, body: 'Synthetic exactly-once body.', language, sourceRefs: [], treatment: 'original_reporting', eventTime: null, assistantAssisted: false });
      const createBody = (title: string, language = 'en') => ({
        owner: { kind: 'person' }, format: 'article', articleFormat: 'practice', originalLanguage: language, licence: 'cc_by', draft: draft(title, language),
        authorship: [{ kind: 'person', id: people.writer, credit: 'Synthetic Crash Writer', assistantAssisted: false }],
      });
      const latest = async (id: string): Promise<View> => body<View>(await writer.get(`/v1/publications/${id}/manage`));
      const audits = (action: string) => () => auditCount(admin, action);
      const staffAudits = (action: string) => () => count(admin, 'SELECT 1 FROM trustwork.admin_audit_event WHERE action = $1', [action]);
      const cmd = (action: string, rest: Record<string, unknown>) => ({ contractVersion: HUB_CONSOLE_CONTRACT_VERSION, idempotencyKey: `crash-${action}`, reason: 'Synthetic crash test', ...rest });
      const run = (action: string, c: Client, url: string, payload: unknown, effects: () => Promise<number>) => exactlyOnce({ action, client: c, url, body: payload, effects });

      let v = body<View>(await run('content.publication_create', writer, '/v1/publications', createBody('Synthetic: exactly once'), audits('publication.created')));
      const P = `/v1/publications/${v.publication.id}`;
      v = body(await run('content.publication_draft', writer, `${P}/draft`, { expectedRevision: v.publication.revision, draft: draft('Synthetic: exactly once, saved'), authorship: null }, audits('publication.draft_saved')));
      v = body(await run('content.publication_submit', writer, `${P}/submit`, { expectedRevision: v.publication.revision }, audits('publication.submitted')));
      v = body(await run('content.publication_return', writer, `${P}/return`, { expectedRevision: v.publication.revision }, audits('publication.returned')));
      v = body(await run('content.editor_grant', writer, `${P}/editors`, { personId: people.coauthor, rights: 'edit' }, audits('publication.editor_granted')));
      v = body(await run('content.editor_revoke', writer, `${P}/editors/${people.coauthor}/revoke`, {}, audits('publication.editor_revoked')));
      v = await latest(v.publication.id);
      v = body(await run('content.publication_links', writer, `${P}/links`, { expectedRevision: v.publication.revision, topics: ['materials'], entityLinks: null }, audits('publication.links_edited')));
      v = body(await run('content.publication_publish', writer, `${P}/publish`, { expectedRevision: v.publication.revision, scheduledFor: null }, audits('publication.published')));
      v = body(await run('content.publication_correct', writer, `${P}/corrections`, { expectedRevision: v.publication.revision, draft: draft('Synthetic: exactly once, corrected'), note: 'Synthetic correction note', reason: 'Synthetic' }, audits('publication.corrected')));
      const es = body<View>(await writer.post('/v1/publications', createBody('Sintetico: una vez', 'es-US')));
      v = body(await run('content.edition_link', writer, `${P}/editions`, { translationId: es.publication.id, machineAssisted: true }, audits('publication.edition_linked')));
      await writer.post(`/v1/publications/${es.publication.id}/editors`, { personId: people.coauthor, rights: 'edit' });
      await run('content.edition_review', coauthor, `/v1/edition-links/${v.editions[0]!.id}/review`, {}, audits('publication.edition_reviewed'));
      await run('content.comment', coauthor, `${P}/comments`, { parentId: null, body: 'Synthetic exactly-once comment' }, audits('publication.commented'));
      const wall = body<{ items: { id: string }[] }>(await run('content.wall_add', writer, '/v1/walls', { wall: { kind: 'person' }, publicationId: v.publication.id, publicationVersion: null, pinned: false }, audits('wall.referenced')));
      await run('content.wall_remove', writer, `/v1/walls/${wall.items[0]!.id}/remove`, {}, audits('wall.reference_removed'));

      type Issue = { issue: { id: string; revision: number }; revisions: { renders: { id: string }[] }[] };
      let issue = body<Issue>(await run('content.issue_create', chief, '/v1/admin/content/issues', cmd('content.issue_create', { number: 1, date: '2026-11-02', theme: null, coverAssetId: null, editorLetterPublicationId: null }), staffAudits('issue.create')));
      const I = `/v1/admin/content/issues/${issue.issue.id}`;
      issue = body(await run('content.issue_curate', chief, `${I}/curate`, cmd('content.issue_curate', { expectedRevision: issue.issue.revision, items: [{ position: 1, section: 'practice', publicationId: v.publication.id, publicationVersion: 1 }], theme: null, coverAssetId: null, editorLetterPublicationId: null }), staffAudits('issue.curate')));
      issue = body(await run('content.issue_status', chief, `${I}/status`, cmd('content.issue_status', { expectedRevision: issue.issue.revision, status: 'curated' }), staffAudits('issue.status')));
      const reviewKey = `plain-${randomBytes(4).toString('hex')}`;
      const review = body<Issue>(await chief.post(`${I}/status`, { contractVersion: HUB_CONSOLE_CONTRACT_VERSION, idempotencyKey: reviewKey, reason: 'Synthetic setup', expectedRevision: issue.issue.revision, status: 'review' }, { idempotencyKey: reviewKey }));
      issue = body(await run('content.issue_release', chief, `${I}/release`, cmd('content.issue_release', { expectedRevision: review.issue.revision }), staffAudits('issue.release')));
      issue = body(await run('content.issue_correct', chief, `${I}/corrections`, cmd('content.issue_correct', { expectedRevision: issue.issue.revision, note: 'Synthetic correction edition' }), staffAudits('issue.correction_open')));
      issue = body(await run('content.render_request', chief, `${I}/renders`, cmd('content.render_request', { edition: 1, format: 'pdf' }), staffAudits('issue.render_requested')));
      const renderId = issue.revisions[0]!.renders[0]!.id;
      await run('content.render_record', chief, `/v1/admin/content/renders/${renderId}/result`, cmd('content.render_record', { outcome: { status: 'failed', failureReason: 'Synthetic renderer outage' } }), staffAudits('issue.render_recorded'));
      const digest = body<{ digest: { id: string; revision: number } }>(await run('content.digest_create', chief, '/v1/admin/content/digests', cmd('content.digest_create', { title: 'Synthetic digest', period: '2026-11', publicationIds: [v.publication.id] }), staffAudits('digest.create')));
      await run('content.digest_release', chief, `/v1/admin/content/digests/${digest.digest.id}/release`, cmd('content.digest_release', { expectedRevision: digest.digest.revision }), staffAudits('digest.release'));
      v = await latest(v.publication.id);
      await run('content.publication_retract', writer, `${P}/retract`, { expectedRevision: v.publication.revision, note: 'Synthetic retraction' }, audits('publication.retracted'));
    } finally {
      if (previousHub === undefined) delete process.env.TRUSTWORK_HUB_ID;
      else process.env.TRUSTWORK_HUB_ID = previousHub;
      delete process.env.TRUSTWORK_CONTENT_COMMENTS;
    }
  },
} satisfies CrashCase;
