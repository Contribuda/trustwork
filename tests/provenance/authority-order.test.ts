import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { bindTransaction, withMaintenance, type Transaction } from '@trustwork/data';
import { sessions, sessionElevations } from '../../packages/data/src/repositories/identity.js';
import { memberships } from '../../packages/data/src/repositories/company.js';
import { staffAssignments } from '../../packages/data/src/repositories/admin.js';
import { publications, issues, digests } from '../../packages/data/src/repositories/content.js';
import { provenance, type ProvenanceContext } from '../../packages/data/src/repositories/provenance.js';
import { ProvenanceWorkspaceSchema, type ProvenanceDeclaration } from '../../packages/contracts/src/provenance.js';
import { provisionTestDatabase, SKIP_REASON } from '../data/helpers/postgres.js';
import { buildContentWorld, credit, draft, refused } from '../content/helpers.js';
import { withProvenanceFixtures } from '../content/provenance-fixture.js';

const db = await provisionTestDatabase('provenance_authority_order');
test('PROV actual owning lock order and post-wait command admission', { skip: db ? false : SKIP_REASON }, async t => {
  if (!db) return;
  t.after(() => db.close());
  await db.migrate(); await db.createAppLogin();
  const w = await buildContentWorld(db.admin, db.app), p = w.people, as = w.act.as;
  const ctx = (key: keyof typeof p): ProvenanceContext => ({ sessionId: w.admin.sessions[key]!, requestId: `authority-${randomUUID()}` });
  const staff = { ...await w.act.elevate(p.chief), ...ctx('chief') };
  const create = (language = 'en') => as(p.writer, trx => publications.create(trx, null, {
    hubId: w.hubId, owner: { kind: 'person' }, format: 'article', articleFormat: 'practice', language,
    licence: 'cc_by', requiresReview: false, draft: draft({ language, assistantAssisted: true }), authorship: credit(p.writer),
  }));
  async function view(id: string) {
    return as(p.writer, async trx => ProvenanceWorkspaceSchema.parse((await sql<{ value: unknown }>`SELECT trustwork.provenance_workspace(${JSON.stringify(ctx('writer'))}::jsonb,${id}::uuid) value`.execute(trx)).rows[0]!.value));
  }
  async function declaration(id: string, original: ProvenanceDeclaration['original'] = null): Promise<ProvenanceDeclaration> {
    const v = await view(id);
    return { binding: v.binding, original, expectedRevision: v.record?.revision ?? 0, kind: original ? 'machine_translation' : 'ai_assisted',
      roles: [original ? 'editorial_translator' : 'editorial_writer'], evidence: 'human_declaration', reason: 'Synthetic exact authority test' };
  }
  async function pair(reviewed = true) {
    let original = await create();
    original = await as(p.writer, trx => withProvenanceFixtures(w).publish(trx, null, original.id, original.revision, null));
    const translation = await create('es');
    assert.ok(original.id < translation.id, 'original UUID must sort before translation in every race');
    const input = await declaration(translation.id, (await view(original.id)).binding);
    const record = await as(p.writer, trx => provenance.declare(trx, ctx('writer'), input));
    await as(p.writer, trx => publications.grantEditor(trx, translation.id, p.coauthor, 'publish'));
    const review = { provenanceId: record.id, binding: input.binding, original: input.original!, reason: 'Synthetic independent review' };
    if (reviewed) await as(p.coauthor, trx => provenance.review(trx, ctx('coauthor'), review));
    return { original, translation: (await as(p.writer, trx => publications.get(trx, translation.id)))!, input, record, review };
  }
  const pid = async (trx: Transaction) => (await sql<{ id: number }>`SELECT pg_backend_pid() id`.execute(trx)).rows[0]!.id;
  async function blocked(waiter: number, holder?: number) {
    for (let i = 0; i < 150; i++) {
      const r = await db!.admin.query<{ ids: number[] }>('SELECT pg_blocking_pids($1) ids', [waiter]);
      if (holder ? r.rows[0]!.ids.includes(holder) : r.rows[0]!.ids.length > 0) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(`backend ${waiter} did not reach the expected database barrier`);
  }
  // First command completes but its transaction stays open; the second must wait at the owning gate.
  async function ordered(firstPerson: string, first: (trx: Transaction) => Promise<unknown>, secondPerson: string, second: (trx: Transaction) => Promise<unknown>, barrier?: { table: string; id: string }) {
    const firstClient = await db!.app.connect(); const secondClient = await db!.app.connect();
    const holder = barrier ? await db!.admin.connect() : null;
    try {
      for (const [c, person] of [[firstClient, firstPerson], [secondClient, secondPerson]] as const) {
        await c.query('BEGIN'); const principal = await w.act.principal(person);
        await c.query('SELECT trustwork.set_principal($1,$2)', [person, principal.authzEpoch]);
      }
      const a = bindTransaction(firstClient), b = bindTransaction(secondClient);
      const aPid = await pid(a), bPid = await pid(b);
      let running: Promise<void | unknown> | undefined;
      if (barrier && holder) {
        await holder.query('BEGIN');
        await holder.query(`SELECT id FROM trustwork.${barrier.table} WHERE id=$1 FOR UPDATE`, [barrier.id]);
        running = first(a).then(() => null, (e: unknown) => e);
        await blocked(aPid);
      } else await first(a);
      const waiting = second(b).then(() => null, (error: unknown) => error);
      await blocked(bPid, aPid);
      if (holder) {
        const locks = await db!.admin.query("SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted", [bPid]);
        assert.equal(locks.rowCount, 1, 'second command waits before taking any publication or bundle lock');
        await holder.query('COMMIT');
        assert.equal(await running, null);
      }
      await firstClient.query('COMMIT');
      const error = await waiting;
      await secondClient.query(error ? 'ROLLBACK' : 'COMMIT');
      return error;
    } finally {
      if (holder) { await holder.query('ROLLBACK'); holder.release(); }
      await firstClient.query('ROLLBACK'); await secondClient.query('ROLLBACK'); firstClient.release(); secondClient.release();
    }
  }
  // A separate owner transaction holds a real domain row; no test sleep chooses the interleaving.
  async function afterWait(person: string, table: string, id: string, command: (trx: Transaction) => Promise<unknown>, change: () => Promise<void>) {
    const holder = await db!.admin.connect(), caller = await db!.app.connect();
    try {
      await holder.query('BEGIN'); await holder.query('SET LOCAL ROLE trustwork_owner');
      await holder.query("SELECT set_config('trustwork.maintenance','on',true)");
      await holder.query(`SELECT id FROM trustwork.${table} WHERE id=$1 FOR UPDATE`, [id]);
      await caller.query('BEGIN'); const principal = await w.act.principal(person);
      await caller.query('SELECT trustwork.set_principal($1,$2)', [person, principal.authzEpoch]);
      const trx = bindTransaction(caller), callerPid = await pid(trx);
      const attempt = command(trx).then(() => null, (error: unknown) => error);
      await blocked(callerPid);
      await change();
      await holder.query('COMMIT');
      const error = await attempt;
      await caller.query(error ? 'ROLLBACK' : 'COMMIT');
      return error as { code?: string; hint?: string } | null;
    } finally {
      await holder.query('ROLLBACK'); await caller.query('ROLLBACK'); holder.release(); caller.release();
    }
  }

  for (const path of ['publish', 'schedule', 'scheduled-worker', 'correction', 'issue', 'digest'] as const) {
    for (const competing of ['declaration', 'review'] as const) {
      for (const first of ['release', 'provenance'] as const) {
        await t.test(`${path} versus ${competing}: ${first} first; original UUID before translation`, async () => {
          const f = await pair(); let pub = f.translation;
          let release: (trx: Transaction) => Promise<unknown>;
          if (['correction', 'issue', 'digest'].includes(path)) pub = await as(p.writer, trx => publications.publish(trx, null, pub.id, pub.revision, null));
          if (path === 'correction') {
            await as(p.writer, trx => sql`SELECT trustwork.provenance_prepare_correction(${JSON.stringify(ctx('writer'))}::jsonb,${pub.id}::uuid,${pub.revision},${JSON.stringify(draft({ language: 'es', body: 'Synthetic correction', assistantAssisted: true }))}::jsonb,'Synthetic correction')`.execute(trx));
            const input = await declaration(pub.id, f.input.original);
            const r = await as(p.writer, trx => provenance.declare(trx, ctx('writer'), input));
            await as(p.coauthor, trx => provenance.review(trx, ctx('coauthor'), { provenanceId: r.id, binding: input.binding, original: input.original!, reason: 'Synthetic correction review' }));
            pub = (await as(p.writer, trx => publications.get(trx, pub.id)))!;
            release = trx => publications.correct(trx, ctx('writer'), pub.id, pub.revision, draft({ language: 'es', body: 'Synthetic correction', assistantAssisted: true }), 'Synthetic correction', 'Synthetic correction');
          } else if (path === 'issue') {
            const v = (await as(p.writer, trx => publications.versions(trx, pub.id))).at(-1)!;
            let i = await as(p.chief, trx => issues.create(trx, staff, { hubId: w.hubId, number: ++issueNumber, date: '2026-11-01', theme: 'Synthetic authority issue', coverAssetId: null, editorLetterId: null }));
            i = await as(p.chief, trx => issues.curate(trx, staff, i.id, i.revision, { items: [{ position: 1, section: 'practice', publicationId: pub.id, publicationVersionId: v.id }], theme: null, coverAssetId: null, editorLetterId: null }));
            for (const state of ['curated', 'review'] as const) i = await as(p.chief, trx => issues.transition(trx, staff, i.id, i.revision, state));
            release = trx => issues.release(trx, staff, i.id, i.revision);
          } else if (path === 'digest') {
            const d = await as(p.chief, trx => digests.create(trx, staff, { hubId: w.hubId, title: 'Synthetic authority digest', period: '2026-11', publicationIds: [pub.id] }));
            release = trx => digests.release(trx, staff, d.id, d.revision);
          } else if (path === 'scheduled-worker') {
            await as(p.writer, trx => publications.publish(trx, null, pub.id, pub.revision, '2099-01-01T00:00:00Z'));
            await withMaintenance(db.admin, trx => trx.updateTable('publication').set({ scheduled_for: new Date(Date.now() - 1000) }).where('id', '=', pub.id).execute());
            // The same owning worker entrypoint, on a connection with the real worker role only.
            release = async trx => { await sql`SET LOCAL ROLE trustwork_worker`.execute(trx); return sql`SELECT trustwork.content_publish_due(1)`.execute(trx); };
          } else release = trx => publications.publish(trx, null, pub.id, pub.revision, path === 'schedule' ? '2099-01-01T00:00:00Z' : null);
          const input = await declaration(pub.id, f.input.original);
          let provCommand: (trx: Transaction) => Promise<unknown> = trx => provenance.declare(trx, ctx('writer'), input);
          if (competing === 'review') {
            const r = first === 'provenance'
              ? await as(p.writer, trx => provenance.declare(trx, ctx('writer'), input))
              : (await as(p.writer, trx => provenance.history(trx, pub.id))).at(-1)!;
            provCommand = trx => provenance.review(trx, ctx('coauthor'), { provenanceId: r.id, binding: input.binding, original: input.original!, reason: 'Synthetic racing review' });
          }
          const releasePerson = path === 'issue' || path === 'digest' ? p.chief : p.writer;
          const provPerson = competing === 'review' ? p.coauthor : p.writer;
          // Worker role membership is explicit and test-local; no provider or production credential exists.
          if (path === 'scheduled-worker') await db.admin.query(`GRANT trustwork_worker TO ${db.app.options.user}`);
          const error = first === 'release'
            ? await ordered(releasePerson, release, provPerson, provCommand, { table: 'publication', id: f.original.id })
            : await ordered(provPerson, provCommand, releasePerson, release, { table: 'publication', id: pub.id });
          if (competing === 'declaration' && first === 'provenance') assert.equal((error as { hint: string })?.hint, 'content.provenance_review_required');
          else if (competing === 'review' && first === 'release') assert.equal((error as { code: string })?.code, '23505');
          else assert.equal(error, null);
          const original = (await as(p.writer, trx => publications.versions(trx, f.original.id)))[0]!;
          assert.equal(original.content_digest, f.input.original!.digest.value);
          // Prevent a scheduled test item from participating in another case's worker batch.
          await withMaintenance(db.admin, trx => trx.updateTable('publication').set({ scheduled_for: new Date('2099-01-01') }).where('id', '=', pub.id).where('status', '=', 'scheduled').execute());
        });
      }
    }
  }

  const actions = ['declare', 'review', 'consent', 'revoke-consent', 'prepare-correction', 'release-correction'] as const;
  async function commandFixture(action: typeof actions[number]) {
        const f = await pair(false); let table = 'publication', id = f.translation.id;
        const key = action === 'review' ? 'coauthor' : 'writer';
        const context = ctx(key);
        let command: (trx: Transaction) => Promise<unknown>;
        if (action === 'declare') command = trx => provenance.declare(trx, context, { ...f.input, expectedRevision: 1 });
        else if (action === 'review') command = trx => provenance.review(trx, context, f.review);
        else if (action === 'consent' || action === 'revoke-consent') {
          const consent = { provenanceId: f.record.id, role: 'responsible_editor', credit: 'Synthetic Writer', channels: ['web'], noticeVersion: 'provenance.credit.v1', informedConsent: true } as const;
          if (action === 'consent') {
            table = 'provenance_record'; id = f.record.id;
            command = trx => provenance.consent(trx, context, { ...consent, channels: ['web'] });
          } else {
            const c = await as(p.writer, trx => provenance.consent(trx, context, { ...consent, channels: ['web'] }));
            table = 'provenance_credit_consent'; id = c.id;
            command = trx => provenance.revoke(trx, context, c.id, 'Synthetic withdrawal');
          }
        } else {
          let original = (await as(p.writer, trx => publications.get(trx, f.original.id)))!;
          id = original.id;
          const changed = draft({ body: 'Synthetic next correction', assistantAssisted: true });
          if (action === 'prepare-correction') command = trx => sql`SELECT trustwork.provenance_prepare_correction(${JSON.stringify(context)}::jsonb,${id}::uuid,${original.revision},${JSON.stringify(changed)}::jsonb,'Synthetic correction')`.execute(trx);
          else {
            await as(p.writer, trx => sql`SELECT trustwork.provenance_prepare_correction(${JSON.stringify(context)}::jsonb,${id}::uuid,${original.revision},${JSON.stringify(changed)}::jsonb,'Synthetic correction')`.execute(trx));
            await as(p.writer, trx => withProvenanceFixtures(w).declare(trx, null, id));
            original = (await as(p.writer, trx => publications.get(trx, id)))!;
            table = 'publication_version'; id = (await as(p.writer, trx => publications.versions(trx, original.id))).at(-1)!.id;
            command = trx => publications.correct(trx, context, original.id, original.revision, changed, 'Synthetic correction', 'Synthetic correction');
          }
        }
    return { f, key, context, table, id, command };
  }
  for (const action of actions) {
    for (const expiry of ['idle_expires_at', 'absolute_expires_at'] as const) {
      await t.test(`${action}: current-clock ${expiry} after an actual domain wait refuses mutation`, async () => {
        const { f, key, context, table, id, command } = await commandFixture(action);
        const error = await afterWait(p[key], table, id, command, async () => {
          await withMaintenance(db.admin, trx => expiry === 'idle_expires_at'
            ? sql`UPDATE trustwork.session SET idle_expires_at=clock_timestamp()+interval '100 milliseconds' WHERE id=${context.sessionId}::uuid`.execute(trx)
            : sql`UPDATE trustwork.session SET idle_expires_at=statement_timestamp()+interval '100 milliseconds',absolute_expires_at=statement_timestamp()+interval '100 milliseconds' WHERE id=${context.sessionId}::uuid`.execute(trx));
          for (;;) {
            const r = await db.admin.query<{ expired: boolean }>(`SELECT clock_timestamp() >= ${expiry} expired FROM trustwork.session WHERE id=$1`, [context.sessionId]);
            if (r.rows[0]!.expired) break;
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        });
        assert.equal(error?.hint, 'provenance.first_party_required');
        await withMaintenance(db.admin, trx => sql`UPDATE trustwork.session SET idle_expires_at=clock_timestamp()+interval '1 day',absolute_expires_at=clock_timestamp()+interval '1 day' WHERE id=${context.sessionId}::uuid`.execute(trx));
        assert.equal((await as(p.writer, trx => provenance.history(trx, f.translation.id))).length, 1);
      });
    }
  }

  for (const action of actions) {
    for (const first of ['revocation', 'command'] as const) {
      await t.test(`${action} versus actual session revocation: ${first} first`, async () => {
        const { key, context, table, id, command } = await commandFixture(action);
        const beforeAudit = await withMaintenance(db.admin, trx => trx.selectFrom('audit_event').select('id').where('request_id', '=', context.requestId).execute());
        const revoke = async (trx: Transaction) => { assert.ok(await sessions.revoke(trx, context.sessionId, 'logout')); };
        if (first === 'command') assert.equal(await ordered(p[key], command, p[key], revoke), null);
        else {
          const error = await afterWait(p[key], table, id, command, () => as(p[key], revoke));
          assert.equal(error?.hint, 'provenance.first_party_required');
          const audit = await withMaintenance(db.admin, trx => trx.selectFrom('audit_event').select('id').where('request_id', '=', context.requestId).execute());
          assert.equal(audit.length, beforeAudit.length, 'delayed refused command commits no new audit or domain mutation');
        }
        const session = await withMaintenance(db.admin, trx => trx.insertInto('session').values({ person_id: p[key], token_hash: randomBytes(32), idle_expires_at: new Date(Date.now()+86400000), absolute_expires_at: new Date(Date.now()+86400000), auth_method: 'password' }).returning('id').executeTakeFirstOrThrow());
        w.admin.sessions[key] = session.id;
      });
    }
  }

  for (const change of ['session', 'epoch', 'editor'] as const) {
    for (const first of ['revocation', 'command'] as const) {
      await t.test(`review versus actual ${change} revocation: ${first} first`, async () => {
        const f = await pair(false), context = ctx('coauthor');
        const membership = change === 'epoch' ? await withMaintenance(db.admin, trx => trx.insertInto('membership').values({ person_id: p.coauthor, company_id: w.company, role: 'member', permissions: [], status: 'active', valid_from: new Date() }).returningAll().executeTakeFirstOrThrow()) : null;
        const revoker = change === 'editor' ? p.writer : change === 'epoch' ? p.employee : p.coauthor;
        const command = (trx: Transaction) => provenance.review(trx, context, f.review);
        const revoke = async (trx: Transaction) => {
          if (change === 'session') await sessions.revoke(trx, context.sessionId, 'logout');
          else if (change === 'editor') await publications.revokeEditor(trx, f.translation.id, p.coauthor);
          else assert.ok(await memberships.end(trx, membership!.id, membership!.revision, p.employee, 'Synthetic membership revocation'));
        };
        if (first === 'command') {
          assert.equal(await ordered(p.coauthor, command, revoker, revoke), null);
          assert.equal((await withMaintenance(db.admin, trx => trx.selectFrom('provenance_review').selectAll().where('provenance_id', '=', f.record.id).execute())).length, 1);
        } else if (change === 'editor') {
          const error = await ordered(p.writer, revoke, p.coauthor, command) as { hint: string };
          assert.equal(error.hint, 'content.not_authorised');
        } else {
          const error = await afterWait(p.coauthor, 'publication', f.translation.id, command, () => as(revoker, revoke));
          assert.equal(error?.hint, change === 'session' ? 'provenance.first_party_required' : 'provenance.authority_changed');
          assert.equal((await withMaintenance(db.admin, trx => trx.selectFrom('provenance_review').selectAll().where('provenance_id', '=', f.record.id).execute())).length, 0);
        }
        if (change === 'session') {
          // New synthetic session, never silently revive or refresh the revoked request session.
          const s = await withMaintenance(db.admin, trx => trx.insertInto('session').values({ person_id: p.coauthor, token_hash: randomBytes(32), idle_expires_at: new Date(Date.now()+86400000), absolute_expires_at: new Date(Date.now()+86400000), auth_method: 'password' }).returning('id').executeTakeFirstOrThrow());
          w.admin.sessions.coauthor = s.id;
        }
      });
    }
  }


  for (const change of ['role', 'elevation'] as const) {
    for (const first of ['revocation', 'command'] as const) {
      await t.test(`staff review versus actual ${change} revocation: ${first} first`, async () => {
        const f = await pair(false);
        const ownerContext = await w.act.elevate(p.owner);
        const assignment = await as(p.owner, trx => staffAssignments.assign(trx, ownerContext, { personId: p.reader, role: 'editor', scope: { kind: 'hub', hubId: w.hubId }, definitionVersion: 1 }));
        const context = { ...await w.act.elevate(p.reader), ...ctx('reader') };
        const command = (trx: Transaction) => provenance.review(trx, context, f.review);
        const revoke = async (trx: Transaction) => {
          if (change === 'role') await staffAssignments.revoke(trx, ownerContext, assignment.id);
          else await sessionElevations.revokeForSession(trx, context.sessionId, 'ended', new Date());
        };
        const revoker = change === 'role' ? p.owner : p.reader;
        if (first === 'command') assert.equal(await ordered(p.reader, command, revoker, revoke), null);
        else {
          const error = await afterWait(p.reader, 'publication', f.translation.id, command, () => as(revoker, revoke));
          assert.equal(error?.hint, 'admin.elevation_required');
          assert.equal((await withMaintenance(db.admin, trx => trx.selectFrom('provenance_review').selectAll().where('provenance_id', '=', f.record.id).execute())).length, 0);
        }
        if (change !== 'role') await as(p.owner, trx => staffAssignments.revoke(trx, ownerContext, assignment.id));
      });
    }
  }
  for (const change of ['role', 'elevation'] as const) {
    await t.test(`staff ${change} expiry is measured after domain wait with current clock`, async () => {
      const f = await pair(false), ownerContext = await w.act.elevate(p.owner);
      const assignment = await as(p.owner, trx => staffAssignments.assign(trx, ownerContext, { personId: p.reader, role: 'editor', scope: { kind: 'hub', hubId: w.hubId }, definitionVersion: 1, validForSeconds: change === 'role' ? 1 : 60 }));
      const context = { ...await w.act.elevate(p.reader, change === 'elevation' ? 1 : 60), ...ctx('reader') };
      const error = await afterWait(p.reader, 'publication', f.translation.id, trx => provenance.review(trx, context, f.review), async () => {
        const deadline = change === 'role' ? assignment.valid_until! : new Date(Date.now() + 1100);
        while ((await db.admin.query<{ done: boolean }>('SELECT clock_timestamp()>$1::timestamptz done', [deadline])).rows[0]!.done === false) await new Promise(resolve => setTimeout(resolve, 10));
      });
      assert.equal(error?.hint, change === 'role' ? 'admin.forbidden' : 'admin.elevation_required');
      await as(p.owner, trx => staffAssignments.revoke(trx, ownerContext, assignment.id));
    });
  }
  await t.test('in-flight inverse role writer refuses NOWAIT without deadlock or a stale approval', async () => {
    const f = await pair(false), ownerContext = await w.act.elevate(p.owner);
    const assignment = await as(p.owner, trx => staffAssignments.assign(trx, ownerContext, { personId: p.reader, role: 'editor', scope: { kind: 'hub', hubId: w.hubId }, definitionVersion: 1 }));
    const context = { ...await w.act.elevate(p.reader), ...ctx('reader') };
    const holder = await db.admin.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM trustwork.staff_role_assignment WHERE id=$1 FOR UPDATE', [assignment.id]);
      await refused(as(p.reader, trx => provenance.review(trx, context, f.review)), '40001', 'content.authority_busy');
      await holder.query('ROLLBACK');
    } finally { await holder.query('ROLLBACK'); holder.release(); }
    await as(p.owner, trx => staffAssignments.revoke(trx, ownerContext, assignment.id));
  });
  await t.test('raw runtime roles cannot bypass the owning gate or mutate publication history', async () => {
    for (const name of ['provenance_content_gate()', `content_lock('${randomUUID()}'::uuid,NULL)`]) {
      await assert.rejects(db.app.query(`SELECT trustwork.${name}`), { code: '42501' });
    }
    for (const table of ['publication', 'publication_version', 'issue_revision', 'magazine_digest', 'edition_link', 'provenance_record', 'provenance_review']) {
      await assert.rejects(db.app.query(`UPDATE trustwork.${table} SET id=id`), { code: '42501' });
    }
    const f = await pair(false);
    await refused(as(p.coauthor, trx => provenance.review(trx, { ...ctx('coauthor'), sessionId: w.admin.sessions.writer! }, f.review)), '42501', 'provenance.first_party_required');
  });

  await t.test('gate contention respects a stricter timeout and returns a conflict without retry', async () => {
    const f = await pair(false), holder = await db.admin.connect();
    try {
      await holder.query('BEGIN'); await holder.query('SELECT pg_advisory_xact_lock(731209,97)');
      await refused(as(p.coauthor, async trx => {
        await sql`SET LOCAL lock_timeout='50ms'`.execute(trx);
        return provenance.review(trx, ctx('coauthor'), f.review);
      }), '40001', 'content.authority_busy');
    } finally { await holder.query('ROLLBACK'); holder.release(); }
  });
  await t.test('a valid elevation from a different session cannot authorize the request', async () => {
    const f = await pair(false), elevation = await w.act.elevate(p.editorB);
    const secondSession = await withMaintenance(db.admin, trx => trx.insertInto('session').values({ person_id: p.editorB, token_hash: randomBytes(32), idle_expires_at: new Date(Date.now()+86400000), absolute_expires_at: new Date(Date.now()+86400000), auth_method: 'password' }).returning('id').executeTakeFirstOrThrow());
    await refused(as(p.editorB, trx => provenance.review(trx, { ...elevation, ...ctx('editorB'), sessionId: secondSession.id }, f.review)), '42501', 'admin.elevation_required');
  });

});
let issueNumber = 200;
