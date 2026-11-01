import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { hash } from '@node-rs/argon2';
import { withMaintenance, withPrincipal, type DataPool, type Transaction } from '@trustwork/data';
import type { Client, Harness, Response } from '../backend/helpers/app.js';
import { principalFor } from '../data/helpers/seed.js';
import { kernelReference, kernelSync } from '../../packages/data/src/repositories/kernel.js';

/**
 * A synthetic world for the PRC-003 suites (every name is fictitious, every address example.invalid):
 * - the buying company "Synthetic Builders": Ada (administrator, holds every procurement permission and
 *   company.deals.manage), Rita (member holding procurement.suppliers.manage through a grant from Ada), Mia (member
 *   without any procurement permission);
 * - the supplier "Synthetic Supply" (claimed): Sam (administrator) and Sid (member without company.deals.manage);
 * - another buyer "Synthetic Elsewhere" with Otto (administrator);
 * - a sourced, unclaimed directory record "Synthetic Sourced Gravel" without members.
 */
export const PASSWORD = 'synthetic-supplier-base-password-01';
export const PEOPLE = ['ada', 'rita', 'mia', 'sam', 'sid', 'otto'] as const;
export type Person = (typeof PEOPLE)[number];
const ALL_COMPANY_PERMISSIONS = ['company.page.edit', 'company.publish', 'company.members.manage', 'company.deals.manage', 'company.catalogue.edit', 'company.billing.view', 'company.billing.manage'];

export interface World {
  label: string;
  buyer: string;
  supplier: string;
  otherBuyer: string;
  sourced: string;
  people: Record<Person, string>;
}

export const loginEmail = (p: Person, label: string) => `supplier-base-${p}-${label}@example.invalid`;
export const uuid = (): string => randomUUID();

export async function syncKernel(admin: DataPool): Promise<void> {
  await withMaintenance(admin, async (trx) => kernelSync.apply(trx, await kernelReference.fromRepository()));
}

export async function grant(admin: DataPool, w: World, person: Person, action: string, companyId = w.buyer, grantedBy: Person = 'ada'): Promise<string> {
  return withMaintenance(admin, async (trx) => (await trx.insertInto('permission_grant').values({ principal_person_id: w.people[person], action, scope: JSON.stringify({ companyId }), granted_by: w.people[grantedBy] }).returning('id').executeTakeFirstOrThrow()).id);
}

export async function seedWorld(h: Harness, label: string): Promise<World> {
  const passwordHash = await hash(PASSWORD, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
  const w = await withMaintenance(h.db.admin, async (trx) => {
    const company = async (name: string, claim: 'claimed' | 'unclaimed', sourced: 'sourced' | 'registered' = 'registered') =>
      (await trx.insertInto('company').values({ display_name: `${name} ${label}`, claim_status: claim, sourced_status: sourced, public_description: `${name}: synthetic test company` }).returning('id').executeTakeFirstOrThrow()).id;
    const buyer = await company('Synthetic Builders', 'claimed');
    const supplier = await company('Synthetic Supply', 'claimed');
    const otherBuyer = await company('Synthetic Elsewhere', 'claimed');
    const sourced = await company('Synthetic Sourced Gravel', 'unclaimed', 'sourced');
    const employer: Record<Person, string> = { ada: buyer, rita: buyer, mia: buyer, sam: supplier, sid: supplier, otto: otherBuyer };
    const admins = new Set<Person>(['ada', 'sam', 'otto']);
    const people = {} as Record<Person, string>;
    for (const p of PEOPLE) {
      const id = (await trx.insertInto('person').values({ display_name: `Synthetic ${p} ${label}`, profile_visibility: 'private' }).returning('id').executeTakeFirstOrThrow()).id;
      people[p] = id;
      await trx.insertInto('email_binding').values({ person_id: id, email_normalized: loginEmail(p, label), is_primary: true, verified_at: new Date('2026-10-01T09:00:00Z') }).execute();
      await trx.insertInto('credential').values({ person_id: id, kind: 'password', password_hash: passwordHash }).execute();
      await trx.insertInto('membership').values({
        person_id: id, company_id: employer[p], role: admins.has(p) ? 'administrator' : 'member', permissions: admins.has(p) ? ALL_COMPANY_PERMISSIONS : [], status: 'active',
        valid_from: new Date('2026-10-01T09:00:00Z'),
      }).execute();
    }
    return { label, buyer, supplier, otherBuyer, sourced, people };
  });
  await grant(h.db.admin, w, 'rita', 'procurement.suppliers.manage');
  return w;
}

export async function signIn(h: Harness, p: Person, label: string): Promise<Client> {
  const client = h.client();
  const response = await client.post('/v1/auth/login', { email: loginEmail(p, label), password: PASSWORD }, { idempotencyKey: null });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return client;
}

export async function as<T>(h: Harness, w: World, p: Person, fn: (trx: Transaction) => Promise<T>): Promise<T> {
  return withPrincipal(h.pool, await principalFor(h.db.admin, w.people[p]), fn);
}

export function ok<T>(r: Response, status = 200): T {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body as T;
}

interface PgError { code?: string; hint?: string; message?: string }
/** Expects a database hint or SQLSTATE. */
export async function fails(promise: Promise<unknown>, expected: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const e = error as PgError;
    assert.ok(e.hint === expected || e.code === expected, `expected ${expected}, got ${e.code} ${e.hint ?? ''} ${e.message ?? ''}`);
    return;
  }
  assert.fail(`expected ${expected}, but it succeeded`);
}

export const count = async (admin: DataPool, query: string, params: unknown[] = []): Promise<number> =>
  (await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${query}) q`, params)).rows[0]?.n ?? 0;

/** Default record fields for repository calls. */
export const fields = (over: Partial<{ status: 'prospect' | 'approved' | 'preferred' | 'on_hold' | 'blocked' | 'archived'; categories: string[]; regions: string[]; internalNotes: string | null; defaultPaymentTerms: string | null; onboarding: unknown[] }> = {}) => ({
  status: 'prospect' as const, categories: [], regions: [], internalNotes: null, defaultPaymentTerms: null, onboarding: [], ...over,
});

/**
 * A concluded agreement and a live order between the buyer and a supplier company, inserted as facts with triggers
 * disabled (`session_replication_role = replica`, superuser test connection only): the card counts them, it does
 * not create them. The real COM-002 path is covered by its own suites.
 */
export async function seedDeal(admin: DataPool, w: World, supplierCompany: string, status: 'accepted_by_both' | 'declined' = 'accepted_by_both'): Promise<string> {
  const client = await admin.connect();
  const hex = () => randomBytes(32).toString('hex');
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL session_replication_role = replica");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO trustwork.agreement (buyer_company_id, seller_company_id, rfq_id, quote_id, quote_version_id, rfq_version_id, offer_version, offer_digest, request_version,
         request_digest, accepted_terms_digest, status, closed_reason, created_by_person_id)
       VALUES ($1, $2, $3, $4, $5, $6, 1, $7, 1, $8, $9, $10, $11, $12) RETURNING id`,
      [w.buyer, supplierCompany, uuid(), uuid(), uuid(), uuid(), hex(), hex(), hex(), status, status === 'declined' ? 'Synthetic decline' : null, w.people.ada]);
    const agreement = rows[0]!.id;
    await client.query(
      `INSERT INTO trustwork.commercial_order (agreement_id, accepted_terms_digest, status, context_kind, context_id, amount_minor, currency, transaction_budget_id, reservation_id, placed_by_person_id, placed_via)
       VALUES ($1, $2, 'accepted', 'rfq', $3, 120000, 'USD', $4, $5, $6, 'person')`,
      [agreement, hex(), uuid(), uuid(), uuid(), w.people.ada]);
    await client.query('COMMIT');
    return agreement;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/* ---------- A minimal XLSX writer for the import tests (stored and deflated entries, inline and shared strings) ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const deflated = deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(deflated.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, deflated);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(deflated.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + deflated.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const col = (i: number) => String.fromCharCode(65 + i);
/** A one-sheet workbook; the header uses shared strings, data cells inline strings (both forms appear in real files). */
export function xlsx(rows: string[][], sheetName = 'Suppliers'): Buffer {
  const header = rows[0] ?? [];
  const shared = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${header.length}" uniqueCount="${header.length}">${header.map((h) => `<si><t>${esc(h)}</t></si>`).join('')}</sst>`;
  const body = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => (v === '' ? '' : ri === 0
    ? `<c r="${col(ci)}${ri + 1}" t="s"><v>${ci}</v></c>`
    : `<c r="${col(ci)}${ri + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`)).join('')}</row>`).join('');
  return zip({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/data.xml"/></Relationships>',
    'xl/worksheets/data.xml': `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`,
    'xl/sharedStrings.xml': shared,
  });
}
