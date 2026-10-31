import type pg from 'pg';

/**
 * Crash points on real PostgreSQL, keyed on the in_progress -> completed transition of an idempotency record.
 *
 * - `handler`: the completion written inside the handler's own transaction (a principal is set on the transaction)
 *   raises, so the whole handler transaction rolls back: a crash before COMMIT.
 * - `bookkeeping`: a completion written by a separate bookkeeping transaction (no principal) raises: whatever was
 *   not committed with the handler is lost, exactly as when the process dies after the handler's COMMIT.
 * - `hold`: the in-transaction completion waits on advisory lock HOLD_LOCK after taking the record's row lock, so a
 *   test can hold an execution between its completion write and its COMMIT.
 */
export const HOLD_LOCK = 50_050;
export type CrashPoint = 'handler' | 'bookkeeping' | 'hold';

export interface CrashPoints {
  arm(...points: CrashPoint[]): Promise<void>;
  disarm(...points: CrashPoint[]): Promise<void>;
  clear(): Promise<void>;
}

export async function installCrashPoints(admin: pg.Pool): Promise<CrashPoints> {
  await admin.query('CREATE TABLE IF NOT EXISTS public.test_idempotency_crash (point text PRIMARY KEY)');
  await admin.query(`CREATE OR REPLACE FUNCTION public.test_idempotency_crash() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    DECLARE
      in_handler boolean := coalesce(current_setting('trustwork.person_id', true), '') <> '';
    BEGIN
      IF OLD.state = 'in_progress' AND NEW.state = 'completed' THEN
        IF in_handler AND EXISTS (SELECT 1 FROM public.test_idempotency_crash WHERE point = 'handler') THEN
          RAISE EXCEPTION 'simulated crash before the handler commit' USING ERRCODE = 'P0001';
        END IF;
        IF NOT in_handler AND EXISTS (SELECT 1 FROM public.test_idempotency_crash WHERE point = 'bookkeeping') THEN
          RAISE EXCEPTION 'simulated crash after the handler commit, before bookkeeping' USING ERRCODE = 'P0001';
        END IF;
        IF in_handler AND EXISTS (SELECT 1 FROM public.test_idempotency_crash WHERE point = 'hold') THEN
          PERFORM pg_advisory_xact_lock(${HOLD_LOCK});
        END IF;
      END IF;
      RETURN NEW;
    END $$`);
  await admin.query('DROP TRIGGER IF EXISTS test_idempotency_crash ON trustwork.idempotency_record');
  await admin.query('CREATE TRIGGER test_idempotency_crash BEFORE UPDATE ON trustwork.idempotency_record FOR EACH ROW EXECUTE FUNCTION public.test_idempotency_crash()');
  return {
    async arm(...points) {
      for (const point of points) await admin.query('INSERT INTO public.test_idempotency_crash (point) VALUES ($1) ON CONFLICT DO NOTHING', [point]);
    },
    async disarm(...points) {
      await admin.query('DELETE FROM public.test_idempotency_crash WHERE point = ANY($1::text[])', [points]);
    },
    async clear() {
      await admin.query('DELETE FROM public.test_idempotency_crash');
    },
  };
}

export async function recordState(admin: pg.Pool, key: string): Promise<{ state: string; expires_at: Date; result: { httpStatus: number; body: unknown } | null } | undefined> {
  const { rows } = await admin.query<{ state: string; expires_at: Date; result: { httpStatus: number; body: unknown } | null }>('SELECT state, expires_at, result FROM trustwork.idempotency_record WHERE key = $1', [key]);
  if (rows.length > 1) throw new Error(`idempotency key ${key} used by more than one scope in this test`);
  return rows[0];
}

/** Number of sessions of this test database waiting on a heavyweight lock (row, transaction or advisory). */
export async function lockWaiters(admin: pg.Pool): Promise<number> {
  const { rows } = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
  return rows[0]?.n ?? 0;
}

/** Polls until `predicate` holds (no fixed sleeps in assertions; bounded so a broken test fails instead of hanging). */
export async function until(predicate: () => Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
