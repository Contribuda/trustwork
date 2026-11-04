import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { withMaintenance, type DataPool } from '@trustwork/data';
import { computeDigest } from '@trustwork/contracts';

type Field = { field: string; before: unknown; after: { kind: string; key?: string } };
type Binding = { proof: Record<string, unknown> | null; show: Record<string, unknown>; extra: Field[] };

/** Every leaf of a digest input, as the database walks it: a list of plain values is one leaf. */
function leaves(value: unknown, path = ''): Array<[string, unknown]> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.length ? entries.flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k)) : [[path, value]];
  }
  if (Array.isArray(value) && value.some((v) => v !== null && typeof v === 'object')) return value.flatMap((v, i) => leaves(v, path ? `${path}.${i}` : String(i)));
  return [[path, value]];
}

/** A digest nothing else holds, with the input that proves it: an approval of it passes the card and matches no command. */
export const forged = { forged: 'synthetic' };
export const forgedDigest = computeDigest(forged).value;

/** The input the database found behind an open approval, to record the same digest under another action. */
export async function digestInputOf(admin: DataPool, approvalId: string): Promise<Record<string, unknown>> {
  const { rows } = await withMaintenance(admin, (trx) => sql<{ binding: Binding }>`SELECT trustwork.admin_change_binding(${approvalId}::uuid) AS binding`.execute(trx));
  return rows[0]!.binding.proof as Record<string, unknown>;
}

/**
 * The card against the digest, for any approval: the input the database says it found must hash to the approval's digest,
 * so nothing was left out of it, and every value in it must be on the card. Driven by the digest input, not by a list of
 * fields, so a field added to a digest and not to the card fails here.
 */
export async function assertCardBinds(admin: DataPool, approvalId: string): Promise<Field[]> {
  const { digest, binding, answer } = await withMaintenance(admin, async (trx) => {
    const { rows } = await sql<{ digest: string; binding: Binding | null; answer: { bound: boolean; complete: boolean; fields: Field[] } }>`SELECT a.action_digest AS digest, trustwork.admin_change_binding(a.id) AS binding,
      trustwork.admin_change_answer(a) AS answer FROM trustwork.second_person_approval a WHERE a.id = ${approvalId}::uuid`.execute(trx);
    return rows[0]!;
  });
  assert.ok(binding, 'something proves what this digest binds');
  assert.deepEqual([answer.bound, answer.complete], [true, true]);
  if (binding.proof) assert.equal(computeDigest(binding.proof).value, digest, 'what the card is generated from is the digest input');
  const card = JSON.stringify(answer.fields);
  // The title and scope of the card, and the hash of an address the card shows masked, are the only values not listed as fields.
  const skip = new Set(['action', 'object', 'hubId', 'newEmailSha256', 'kind']);
  for (const [path, value] of [...(binding.proof ? leaves(binding.proof) : []), ...leaves(binding.show)]) {
    if (skip.has(path)) continue;
    if (value === null || value === undefined || (Array.isArray(value) && !value.length) || (typeof value === 'object' && !Array.isArray(value))) {
      assert.ok(answer.fields.some((f) => f.field === path), `the card lists ${path}`);
    } else if (typeof value === 'boolean') {
      assert.equal(answer.fields.find((f) => f.field === path)?.after.key, value ? 'approvals.values.yes' : 'approvals.values.no', `the card says ${path}`);
    } else {
      for (const part of Array.isArray(value) ? value : [value]) assert.ok(card.includes(JSON.stringify(String(part)).slice(1, -1)), `the card shows ${path}: ${String(part)}`);
    }
  }
  return answer.fields;
}
