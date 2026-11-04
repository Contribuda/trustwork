import { createHmac, randomUUID } from 'node:crypto';
import { expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { HUBS } from '../../../apps/web/app/admin/_fixtures/hubs.js';
import { CONTROL_ORIGIN, WEB_ORIGIN } from './ports.js';
import { msg, PASSWORD, SAME_ORIGIN, verifiedAccount } from './support.js';

/**
 * Staff of the live console journeys (HUBC-007): a synthetic person with a real second factor and an elevated session, a
 * hub created through the API, and the console's forms. Every person and hub is synthetic.
 */
export const LANG = 'ka' as const;

function base32Decode(text: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of text.replace(/=+$/, '')) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  return Buffer.from(bits.match(/.{8}/g)!.map((b) => Number.parseInt(b, 2)));
}
function totpAt(secretBase32: string, ms: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(ms / 30_000)));
  const mac = createHmac('sha1', base32Decode(secretBase32)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export async function control(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`${CONTROL_ORIGIN}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(response.status, `${path}: ${await response.clone().text()}`).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

/** A staff mutation outside the browser UI: same origin, CSRF header and an idempotency key in header and body. */
export async function staffPost(request: APIRequestContext, path: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
  const key = randomUUID();
  const response = await request.post(path, { headers: { ...SAME_ORIGIN, 'Idempotency-Key': key }, data: { contractVersion: '1.0.0', idempotencyKey: key, reason: 'Synthetic console journey', ...data } });
  expect(response.status(), `${path}: ${await response.text()}`).toBeLessThan(300);
  return (await response.json()) as Record<string, unknown>;
}

export type Enrolled = { personId: string; email: string; elevate: () => Promise<void> };

/** A signed-in person with a second factor; `elevate` opens an elevated staff session with a fresh code. */
export async function enrolled(context: BrowserContext, name: string): Promise<Enrolled> {
  const { personId, email } = await verifiedAccount(context.request, name);
  const stepUp = async () => expect((await context.request.post('/v1/auth/step-up', { headers: SAME_ORIGIN, data: { password: PASSWORD } })).status()).toBe(200);
  await stepUp();
  const started = await context.request.post('/v1/me/second-factor/totp', { headers: SAME_ORIGIN });
  expect(started.status(), await started.text()).toBe(201);
  const { factorId, secret } = (await started.json()) as { factorId: string; secret: string };
  const confirmed = await context.request.post('/v1/me/second-factor/totp/confirm', { headers: SAME_ORIGIN, data: { factorId, code: totpAt(secret, Date.now()) } });
  expect(confirmed.status(), await confirmed.text()).toBe(200);
  return {
    personId, email,
    elevate: async () => {
      await stepUp();
      const elevated = await context.request.post('/v1/admin/session/elevate', { headers: SAME_ORIGIN, data: { proof: { method: 'totp', code: totpAt(secret, Date.now() + 30_000) } } });
      expect(elevated.status(), await elevated.text()).toBe(200);
    },
  };
}

export async function inGeorgian(context: BrowserContext): Promise<void> {
  await context.addCookies([{ name: 'trustwork.country', value: 'GE', url: WEB_ORIGIN }, { name: 'trustwork.locale', value: LANG, url: WEB_ORIGIN }]);
}

/** A node operator creates a Georgian hub through the API; a steward then activates its first modes version. */
export async function liveHub(browser: { newContext(): Promise<BrowserContext> }, slug: string): Promise<{ hubId: string }> {
  const context = await browser.newContext();
  const operator = await enrolled(context, 'Synthetic Node Operator');
  await control('/staff', { personId: operator.personId, role: 'ops-engineer', permissions: ['admin.node.hubs.manage', 'admin.hub.read', 'admin.hub.modes.edit', 'admin.config.edit'], scope: { kind: 'node' } });
  await operator.elevate();
  const created = await staffPost(context.request, '/v1/admin/hubs', {
    slug, name: { ka: 'სინთეზური ჰაბი', en: 'Synthetic Console Hub' }, defaultLocale: 'ka', locales: ['ka', 'en'], timeZone: 'Asia/Tbilisi', currency: 'GEL', countryPack: null, territories: [{ level: 'country', code: 'GE' }],
  });
  const hubId = (created.result as { objectId: string }).objectId;
  const draft = await staffPost(context.request, `/v1/admin/hubs/${hubId}/config`, { domain: 'modes', payload: { ...HUBS[0]!.modes, dataMode: 'live' } });
  const version = draft.version as { id: string; revision: number };
  await staffPost(context.request, `/v1/admin/hubs/${hubId}/config/${version.id}/activate`, { expectedRevision: version.revision, approvalId: null });
  await context.close();
  return { hubId };
}

/** Fills the reason of the form inside `scope` and submits it; returns the form's status line. */
export async function submitIn(page: Page, scope: string, submitLabel: string) {
  const form = page.locator(`${scope} form`).filter({ has: page.getByRole('button', { name: submitLabel, exact: true }) }).first();
  await form.getByLabel(msg('admin.common.reason', LANG)).fill('Synthetic console journey');
  await form.getByRole('button', { name: submitLabel, exact: true }).click();
  return form.locator('.admin-form__result');
}
