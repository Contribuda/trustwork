import assert from 'node:assert/strict';
import type pg from 'pg';
import { base32Decode, totp } from '../../../apps/api/src/modules/identity/second-factor/totp.js';
import type { Client, Harness, Response } from '../helpers/app.js';
import { EMAILS, PASSWORDS, type PersonaKey } from '../helpers/personas.js';
import { lockWaiters, until } from '../idempotency/helpers.js';

export interface Enrolled { factorId: string; secret: Buffer; recoveryCodes: string[] }

/** The code an authenticator app would show now (by the harness clock). */
export function codeNow(h: Harness, secret: Buffer, offsetSteps = 0): string {
  return totp(secret, h.clock.now().getTime() + offsetSteps * 30_000);
}
/** Moves the harness clock to the next 30-second step and returns that step's code (a fresh, never-used code). */
export function nextCode(h: Harness, secret: Buffer): string {
  h.clock.advance(30_000);
  return codeNow(h, secret);
}

/** Enrols TOTP for the signed-in client through the API (step-up must be fresh) and returns the secret and codes. */
export async function enrol(h: Harness, client: Client): Promise<Enrolled> {
  const started = await client.post('/v1/me/second-factor/totp', undefined, { idempotencyKey: null });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const body = started.body as { factorId: string; secret: string; otpauthUri: string };
  const secret = base32Decode(body.secret);
  const confirmed = await client.post('/v1/me/second-factor/totp/confirm', { factorId: body.factorId, code: codeNow(h, secret) }, { idempotencyKey: null });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  const result = confirmed.body as { recoveryCodes: string[] | null };
  assert.ok(result.recoveryCodes, 'recovery codes are issued with the first factor');
  return { factorId: body.factorId, secret, recoveryCodes: result.recoveryCodes };
}

/** Password step of sign-in. */
export function passwordLogin(client: Client, key: PersonaKey): Promise<Response> {
  return client.post('/v1/auth/login', { email: EMAILS[key], password: PASSWORDS[key] }, { idempotencyKey: null });
}
export function secondStep(client: Client, proof: { method: 'totp' | 'recovery_code'; code: string }): Promise<Response> {
  return client.post('/v1/auth/second-factor', { proof }, { idempotencyKey: null });
}
/** Full sign-in of an enrolled persona with a fresh TOTP code. */
export async function signInWithTotp(h: Harness, client: Client, key: PersonaKey, secret: Buffer): Promise<void> {
  const first = await passwordLogin(client, key);
  assert.equal((first.body as { status?: string }).status, 'second_factor_required', JSON.stringify(first.body));
  const second = await secondStep(client, { method: 'totp', code: nextCode(h, secret) });
  assert.equal(second.status, 200, JSON.stringify(second.body));
}
export async function elevate(h: Harness, client: Client, secret: Buffer): Promise<{ elevationId: string; expiresAt: string }> {
  const response = await client.post('/v1/admin/session/elevate', { proof: { method: 'totp', code: nextCode(h, secret) } }, { idempotencyKey: null });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body as { elevationId: string; expiresAt: string };
}

/** security_notice events committed to an address, in order. */
export async function notices(h: Harness, address: string): Promise<string[]> {
  return (await h.mail.to(address, 'security_notice')).map((m) => m.params.event as string);
}

/**
 * Gate for concurrency tests: a BEFORE UPDATE trigger on `table` waits on advisory lock `key` that the test holds, so
 * the first transaction to update a row stops inside its update (row locked, not committed) while the competing one
 * queues behind it. Releasing the lock lets both finish; the database then decides who wins.
 */
export async function installUpdateGate(admin: pg.Pool, table: 'second_factor' | 'recovery_code', key: number): Promise<{ race<T>(start: () => Promise<T>, waiters?: number): Promise<T>; hold(): Promise<pg.PoolClient>; drop(): Promise<void> }> {
  await admin.query(`CREATE OR REPLACE FUNCTION public.test_gate_${table}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    BEGIN PERFORM pg_advisory_xact_lock(${key}); RETURN NEW; END $$`);
  await admin.query(`DROP TRIGGER IF EXISTS test_gate ON trustwork.${table}`);
  await admin.query(`CREATE TRIGGER test_gate BEFORE UPDATE ON trustwork.${table} FOR EACH ROW EXECUTE FUNCTION public.test_gate_${table}()`);
  const hold = async (): Promise<pg.PoolClient> => {
    const client = await admin.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [key]);
    return client;
  };
  return {
    hold,
    /**
     * Holds the gate, starts `race`, waits until `waiters` sessions queue on locks, then opens the gate and returns
     * the results. The gate is always released, so a failing assertion never leaves a transaction open.
     */
    async race<T>(start: () => Promise<T>, waiters = 2): Promise<T> {
      const held = await hold();
      let racing: Promise<T> | null = null;
      try {
        racing = start();
        await until(async () => (await lockWaiters(admin)) >= waiters, 'the competing transactions to queue on the gate');
      } finally {
        await held.query('COMMIT').catch(() => undefined);
        held.release();
      }
      return racing;
    },
    async drop() {
      await admin.query(`DROP TRIGGER IF EXISTS test_gate ON trustwork.${table}`);
    },
  };
}
