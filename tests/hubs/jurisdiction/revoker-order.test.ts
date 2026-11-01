import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { withMaintenance } from '@trustwork/data';
import { staffAssignments } from '../../../packages/data/src/repositories/admin.js';
import { secondFactorResets } from '../../../packages/data/src/repositories/identity.js';
import { jurisdictionApplicabilityReview, jurisdictionEvidence } from '../../../packages/data/src/repositories/jurisdiction-policy.js';
import { startHarness } from '../../backend/helpers/app.js';
import { authorityFixture } from './authority-fixture.js';

const h = await startHarness('jurisdiction_revoker_order');
test('current owning revokers cannot deadlock jurisdiction authority in inverse order', { skip: !h }, async t => {
  if (!h) return;
  t.after(() => h.close());
  const f = await authorityFixture(h.db.admin, h.pool);
  const waitFor = async (condition: () => Promise<boolean>) => {
    for (let n = 0; n < 200; n++) {
      if (await condition()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('expected database lock boundary was not reached');
  };
  for (const kind of ['role', 'support_reset'] as const) {
    await t.test(`${kind}: revoker holds its first row before jurisdiction acquires another authority row`, async () => {
      const person = kind === 'role' ? f.p.owner : f.p.officer;
      const session = kind === 'role' ? f.world.sessions.owner : f.world.sessions.officer;
      const ctx = await f.a.elevate(person);
      const founder = await f.a.elevate(f.p.founder);
      const evidence = await withMaintenance(h.db.admin, trx => jurisdictionEvidence.stageApplicability(trx, {
        subjectKind: 'person', subjectId: f.p.outsider, hubId: f.hubId, jurisdictions: ['US'],
        evidenceId: 'synthetic.inverseOrder', evidenceDigest: 'e'.repeat(64), effectiveFrom: '2020-01-01T00:00:00.000Z', effectiveUntil: '2099-01-01T00:00:00.000Z',
      }));
      const assignment = (await h.db.admin.query('SELECT id FROM trustwork.staff_role_assignment WHERE person_id=$1 AND revoked_at IS NULL', [person])).rows[0]!.id as string;
      // Synthetic elapsed cooling-off evidence; the actual owning execute function performs all revocations.
      const reset = kind === 'support_reset' ? (await h.db.admin.query(`INSERT INTO trustwork.second_factor_reset
        (subject_person_id,support_case_id,evidence_refs,reason,requested_by,requested_at,approved_by,approved_at,effective_at,state)
        VALUES($1,$2,ARRAY[$3]::uuid[],'Synthetic identity recovery evidence',$4,now()-interval '74 hours',$5,now()-interval '73 hours',now()-interval '1 hour','cooling_off') RETURNING id`,
      [person, randomUUID(), randomUUID(), f.p.founder, f.p.founder2])).rows[0]!.id as string : null;
      const blocker = await h.db.admin.connect();
      let revokerPid = 0, commandPid = 0, settled = false;
      const result = (error: unknown) => error as { code: string; message: string; detail?: string };
      await blocker.query('BEGIN');
      // Compatible with jurisdiction SHARE, incompatible with the revoker's later UPDATE.
      await blocker.query(kind === 'role' ? 'SELECT id FROM trustwork.session_elevation WHERE person_id=$1 FOR SHARE' : 'SELECT id FROM trustwork.session WHERE person_id=$1 FOR SHARE', [person]);
      const revoke = f.a.as(f.p.founder, async trx => {
        revokerPid = (await sql<{ pid: number }>`SELECT pg_backend_pid() pid`.execute(trx)).rows[0]!.pid;
        if (reset) await secondFactorResets.execute(trx, reset);
        else await staffAssignments.revoke(trx, founder, assignment);
      }).then(() => null, result);
      let command: Promise<ReturnType<typeof result> | null> | undefined;
      try {
        await waitFor(async () => revokerPid !== 0 && (await h.db.admin.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type=\'Lock\'', [revokerPid])).rowCount === 1);
        command = f.a.as(person, async trx => {
          commandPid = (await sql<{ pid: number }>`SELECT pg_backend_pid() pid`.execute(trx)).rows[0]!.pid;
          return jurisdictionApplicabilityReview.propose(trx, session, ctx, evidence.id, evidence.digest);
        }).then(() => null, result).finally(() => { settled = true; });
        await waitFor(async () => settled || (commandPid !== 0 && (await h.db.admin.query('SELECT $1=ANY(pg_blocking_pids($2)) blocked', [revokerPid, commandPid])).rows[0]!.blocked === true));
      } finally {
        await blocker.query('ROLLBACK'); blocker.release();
      }
      const [revocation, refusal] = await Promise.all([revoke, command]);
      assert.equal(revocation, null, `owning revoker must commit: ${JSON.stringify(revocation)}`);
      assert.equal(refusal?.code, '55P03', `bounded conflict refusal, never an accepted deadlock: ${JSON.stringify(refusal)}`);
      assert.equal((await h.db.admin.query('SELECT 1 FROM trustwork.jurisdiction_applicability_review WHERE evidence_id=$1', [evidence.id])).rowCount, 0);
    });
  }
});
