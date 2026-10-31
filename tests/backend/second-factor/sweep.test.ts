import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { runSweep } from '../../../apps/api/src/dev/sweep.js';
import { provisionTestDatabase, SKIP_REASON } from '../../data/helpers/postgres.js';
import { seedFixtures } from '../../data/helpers/seed.js';

const db = await provisionTestDatabase('second_factor_sweep');
const hash = (s: string): Buffer => createHash('sha256').update(s).digest();
const days = (n: number): Date => new Date(Date.now() - n * 86_400_000);

/**
 * BE-004 follow-up on real PostgreSQL: the worker's sweep (trustwork.sweep_expired) deletes sessions long after they
 * ended and purges never-verified sign-ups. Rows of the second-factor slice that point at those sessions or people go
 * with them instead of aborting the whole sweep with a foreign-key error; live rows and staff references stay.
 */
test('the sweep removes swept sessions\' elevations and purged sign-ups\' factors without failing', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  await db.migrate();
  const seed = await seedFixtures(db.admin);
  t.after(() => db.close());
  const staff = seed.people.petr;
  const q = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);

  // A staff session that ended 100 days ago and was elevated while it was live, plus a live elevated session.
  const ended = (await q(`INSERT INTO trustwork.session (person_id, token_hash, created_at, last_seen_at, idle_expires_at, absolute_expires_at, authenticated_at, auth_method)
    VALUES ($1, $2, $3, $3, now() + interval '1 hour', now() + interval '1 hour', $3, 'password') RETURNING id`, [staff, hash('ended-session'), days(101)])).rows[0].id as string;
  const live = (await q(`INSERT INTO trustwork.session (person_id, token_hash, idle_expires_at, absolute_expires_at, auth_method)
    VALUES ($1, $2, now() + interval '1 hour', now() + interval '2 hours', 'password') RETURNING id`, [staff, hash('live-session')])).rows[0].id as string;
  await q(`INSERT INTO trustwork.session_elevation (session_id, person_id, factor_kind, created_at, expires_at) VALUES ($1, $2, 'totp', $3::timestamptz, $3::timestamptz + interval '15 minutes')`, [ended, staff, days(101)]);
  await q(`INSERT INTO trustwork.session_elevation (session_id, person_id, factor_kind, created_at, expires_at) VALUES ($1, $2, 'totp', now(), now() + interval '15 minutes')`, [live, staff]);
  await q(`UPDATE trustwork.session SET revoked_at = $2, revoked_reason = 'logout', idle_expires_at = $2, absolute_expires_at = $2 WHERE id = $1`, [ended, days(100)]);

  // A never-verified sign-up older than seven days that a factor, recovery code, challenge and support reset point at.
  const ghost = (await q(`INSERT INTO trustwork.person (display_name, created_at) VALUES ('never verified', $1) RETURNING id`, [days(8)])).rows[0].id as string;
  await q(`INSERT INTO trustwork.email_binding (person_id, email_normalized, is_primary) VALUES ($1, 'ghost-2fa@example.invalid', true)`, [ghost]);
  await q(`INSERT INTO trustwork.second_factor (id, person_id, kind, state, secret_sealed, pending_expires_at) VALUES ($1, $2, 'totp', 'pending', $3, now() + interval '10 minutes')`, [randomUUID(), ghost, randomBytes(49)]);
  await q(`INSERT INTO trustwork.recovery_code (person_id, batch_id, code_hash) VALUES ($1, $2, $3)`, [ghost, randomUUID(), hash('ghost-code')]);
  await q(`INSERT INTO trustwork.second_factor_challenge (person_id, token_hash, auth_method, expires_at) VALUES ($1, $2, 'password', now() + interval '5 minutes')`, [ghost, hash('ghost-challenge')]);
  const reset = (await q(`INSERT INTO trustwork.second_factor_reset (subject_person_id, support_case_id, evidence_refs, reason, requested_by) VALUES ($1, $2, ARRAY[$3]::uuid[], 'Lost phone, identity checked', $4) RETURNING id`, [ghost, randomUUID(), randomUUID(), staff])).rows[0].id as string;
  // A reset of a live person keeps its row and its staff reference.
  const kept = (await q(`INSERT INTO trustwork.second_factor_reset (subject_person_id, support_case_id, evidence_refs, reason, requested_by) VALUES ($1, $2, ARRAY[$3]::uuid[], 'Lost phone, identity checked', $4) RETURNING id`, [seed.people.anna, randomUUID(), randomUUID(), staff])).rows[0].id as string;

  const report = await runSweep(db.admin);
  assert.equal(report.sessions, 1, 'the ended session is swept');
  assert.equal(report.unverified_persons, 1, 'the never-verified sign-up is purged');

  const count = async (sql: string, params: unknown[]) => Number((await q(`SELECT count(*)::int AS n FROM (${sql}) x`, params)).rows[0].n);
  assert.equal(await count('SELECT 1 FROM trustwork.session_elevation WHERE session_id = $1', [ended]), 0, 'the swept session\'s elevation went with it');
  assert.equal(await count('SELECT 1 FROM trustwork.session_elevation WHERE session_id = $1', [live]), 1, 'a live elevation stays');
  for (const table of ['second_factor', 'recovery_code', 'second_factor_challenge']) assert.equal(await count(`SELECT 1 FROM trustwork.${table} WHERE person_id = $1`, [ghost]), 0, `${table} of the purged sign-up`);
  assert.equal(await count('SELECT 1 FROM trustwork.second_factor_reset WHERE id = $1', [reset]), 0, 'the reset of a purged person');
  assert.equal(await count('SELECT 1 FROM trustwork.second_factor_reset WHERE id = $1 AND requested_by = $2', [kept, staff]), 1, 'other resets keep their staff reference');

  // Staff references are not cascaded: deleting a requester who still has a reset is refused.
  await assert.rejects(q('DELETE FROM trustwork.person WHERE id = $1', [staff]), (e: unknown) => (e as { code?: string }).code === '23503');
  // A second sweep has nothing left to fail on.
  const again = await runSweep(db.admin);
  assert.equal(again.sessions, 0);
});
