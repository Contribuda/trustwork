import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { withMaintenance } from '@trustwork/data';
import { provisionWorkerDatabase, waitFor } from '../worker/helpers/worker-db.js';
import { provisionPrivacyDrill, recordPrivacyDrill } from '../../scripts/restore/privacy-drill.js';
import { reconcileRestore } from '../../scripts/restore/reconcile.js';
import { RoleFence } from '../../scripts/restore/fence.js';
import { runLocalPrivacyRestoreCli } from '../../scripts/restore/cli.js';

test('source-v2 CLI recovery: independent retained authority, fail-closed fence and crash-held locks', { timeout: 120_000 }, async (t) => {
  for (const variant of ['valid', 'corrupt', 'missing', 'wrong', 'unsupported', 'hold', 'conflicting-evidence', 'crash-before-lift'] as const) {
    await t.test(variant, async () => {
      const env = await provisionWorkerDatabase(`source_restore_${variant.replaceAll('-', '_')}`); assert.ok(env);
      const root = await mkdtemp(join(tmpdir(), 'source-v2-restore-'));
      try {
        const people = await withMaintenance(env.db.admin, async (trx) => (await trx.insertInto('person').values([
          { display_name: 'Synthetic source restore subject' }, { display_name: 'Synthetic source restore approver' }]).returning('id').execute()).map((r) => r.id));
        const fixture = await provisionPrivacyDrill(root, env.db.admin, people); await recordPrivacyDrill(fixture, env.db.admin);
        const source = fixture.sourceV2!;
        const entries = await fixture.ledger.all(); const decision = entries.find((e) => e.record.version === 2)!.record;
        assert.equal(decision.version, 2);
        if (variant === 'corrupt') await writeFile(join(fixture.binding.journalDirectory, '000000000002.json'), '{}');
        if (variant === 'missing') await rm(join(fixture.binding.journalDirectory, '000000000002.json'));
        if (variant === 'wrong') await writeFile(join(fixture.binding.journalDirectory, 'identity.json'), JSON.stringify({ journalId: randomUUID() }));
        if (variant === 'unsupported') await fixture.ledger.record({ version: 1, requestId: randomUUID(), subject: { kind: 'person', id: people[0]! },
          executedBy: source.officer, approvedBy: source.reviewer, policyDigest: 'b'.repeat(64), recordedAt: new Date().toISOString(), modules: ['communications'], suppressionDigests: [] });
        if (variant === 'hold') await env.db.admin.query(`INSERT INTO trustwork.privacy_source_hold(source_field_id,placed_by,reason_code,evidence_ref)
          VALUES($1,$2,'litigation',$3)`, [source.fieldId, source.officer, randomUUID()]);
        if (variant === 'conflicting-evidence') await fixture.ledger.record({ ...decision, requestId: randomUUID(), evidenceDigest: 'f'.repeat(64) });
        const fence = new RoleFence(env.db.admin, [env.db.appLoginRole]); await fence.apply();
        const databaseUrl = new URL(`/${env.db.databaseName}`, env.db.clusterUrl).toString();
        const restoreId = `synthetic-v2-${randomUUID()}`; const now = new Date();
        await reconcileRestore({ admin: env.db.admin, restoreId, recoveryPoint: now, restoreStartedAt: now,
          journal: { receipts: [], completeThrough: now }, operator: 'synthetic-source-v2' });
        const deniedLogin = async () => {
          const client = new pg.Client(env.db.appConfig);
          try { await assert.rejects(client.connect(), /not permitted to log in/); } finally { await client.end().catch(() => undefined); }
        };
        await deniedLogin();
        const errors: string[] = [];
        const cli = () => runLocalPrivacyRestoreCli(['authorize', '--restore-id', restoreId, '--reference', 'synthetic-v2', '--operator', 'synthetic-v2', '--logins', env.db.appLoginRole],
          { RESTORE_DATABASE_URL: databaseUrl }, { out: () => undefined, err: (line) => errors.push(line) }, fixture.binding);
        if (variant === 'crash-before-lift') {
          const child = fork(new URL('./fixtures/journal-process.ts', import.meta.url), [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
          const exited = once(child, 'exit'); const messages: Array<{ stage?: string; error?: string }> = [];
          child.on('message', (m) => messages.push(m as typeof messages[number]));
          child.send({ action: 'restore', binding: fixture.binding, databaseUrl, login: env.db.appLoginRole, restoreId, pause: 'before_lift' });
          try { await waitFor(async () => messages.some((m) => m.stage === 'before_lift'), 10_000, `source-v2 committed before lift: ${JSON.stringify(messages)}`); }
          finally { child.kill('SIGKILL'); await exited; }
          assert.ok(await fence.isApplied());
          assert.equal((await env.db.admin.query('SELECT count(*)::int n FROM trustwork.source_privacy_replay_receipt WHERE request_id=$1', [source.requestId])).rows[0].n, 1);
        }
        const code = await cli();
        if (variant === 'valid') {
          assert.equal(code, 0, errors.join('\n')); assert.equal(await fence.isApplied(), false);
          const checkpoint = JSON.parse(await readFile(join(fixture.binding.authorityDirectory, 'checkpoint.json'), 'utf8'));
          assert.equal(checkpoint.sealed, true);
          await assert.rejects(fixture.ledger.record({ ...decision, requestId: randomUUID() }), /sealed/);
        } else {
          assert.equal(code, 1); assert.ok(await fence.isApplied()); await deniedLogin();
          assert.ok((await stat(join(fixture.binding.authorityDirectory, 'operation.lock'))).isDirectory());
          assert.equal(await cli(), 1, 'no TTL, lock stealing, replacement or retry-based recovery');
          assert.ok(errors.at(-1)?.includes('locked'));
          if (variant === 'hold' || variant === 'conflicting-evidence' || variant === 'crash-before-lift') {
            assert.equal(JSON.parse(await readFile(join(fixture.binding.authorityDirectory, 'checkpoint.json'), 'utf8')).sealed, true);
          }
        }
        const evidence = (await env.db.admin.query<{ digest: string }>("SELECT trustwork.admin_digest(to_jsonb(f)-'active'-'deactivated_at'-'takedown_id') AS digest FROM trustwork.sourced_record_field f WHERE id=$1", [source.fieldId])).rows[0]!.digest;
        assert.equal(evidence, source.evidenceDigest);
      } finally { await env.close(); await rm(root, { recursive: true, force: true }); }
    });
  }
});
