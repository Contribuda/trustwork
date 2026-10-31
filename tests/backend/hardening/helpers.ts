import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { Client } from '../helpers/app.js';

/** Lockout subjects exactly as the API hashes them (sha256 of `account:<address>` / `ip:<address>`). */
export const subject = (kind: 'account' | 'ip', value: string): Buffer => createHash('sha256').update(`${kind}:${value}`, 'utf8').digest();

export async function count(admin: pg.Pool, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) q`, params);
  return rows[0]?.n ?? 0;
}
export const auditCount = (admin: pg.Pool, action: string): Promise<number> => count(admin, 'SELECT 1 FROM trustwork.audit_event WHERE action = $1', [action]);
export const outboxCount = (admin: pg.Pool, type: string, personId?: string): Promise<number> =>
  personId ? count(admin, 'SELECT 1 FROM trustwork.outbox_event WHERE type = $1 AND aggregate_id = $2', [type, personId]) : count(admin, 'SELECT 1 FROM trustwork.outbox_event WHERE type = $1', [type]);

/**
 * Forced failure at the audit write: a BEFORE INSERT trigger on audit_event (cloned to every partition) raises for
 * the listed actions. The change of the flow has already happened in the same transaction, so a correct flow rolls
 * it back; a flow that committed its change separately would leave it behind.
 */
export async function installAuditFault(admin: pg.Pool): Promise<{ fail(action: string): Promise<void>; clear(): Promise<void> }> {
  await admin.query('CREATE TABLE IF NOT EXISTS public.test_audit_fault (action text PRIMARY KEY)');
  await admin.query(`CREATE OR REPLACE FUNCTION public.test_audit_fault() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM public.test_audit_fault f WHERE f.action = NEW.action) THEN
        RAISE EXCEPTION 'forced audit failure for %', NEW.action USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END $$`);
  await admin.query('DROP TRIGGER IF EXISTS test_audit_fault ON trustwork.audit_event');
  await admin.query('CREATE TRIGGER test_audit_fault BEFORE INSERT ON trustwork.audit_event FOR EACH ROW EXECUTE FUNCTION public.test_audit_fault()');
  return {
    async fail(action) {
      await admin.query('INSERT INTO public.test_audit_fault (action) VALUES ($1) ON CONFLICT DO NOTHING', [action]);
    },
    async clear() {
      await admin.query('DELETE FROM public.test_audit_fault');
    },
  };
}

/** Starts a provider flow and returns the `state` the fake authority hands back to the callback. */
export async function providerState(client: Client, provider: 'google' | 'apple'): Promise<string> {
  const start = await client.post(`/v1/auth/${provider}/start`, undefined, { idempotencyKey: null });
  if (start.status !== 200) throw new Error(`provider start failed: ${start.status} ${JSON.stringify(start.body)}`);
  return new URL((start.body as { authorizationUrl: string }).authorizationUrl).searchParams.get('state') as string;
}

export const PASSWORD = 'correct horse battery staple 42';
export const signupBody = (email: string, name = 'Fixture Person', password = PASSWORD) => ({ name, email, password, acceptedTermsVersion: 'draft-2026-10' });
