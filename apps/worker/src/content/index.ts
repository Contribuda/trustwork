import { sql } from 'kysely';
import { z } from 'zod';
import type { DataPool } from '@trustwork/data';
import { contentWorker } from '../../../../packages/data/src/repositories/content.js';
import { inTransaction } from '../db.js';
import type { HandlerRegistry } from '../handlers.js';
import type { ScheduledTask } from '../scheduler.js';
import { renderLocalPdf, type PdfRenderer } from './render.js';

export const CONTENT_RENDER_KIND = 'content.render_pdf';
const Payload = z.strictObject({ renderId: z.uuid() });
/** Releases what a person scheduled once its time comes. Every publication rule is rechecked in the database. */
export function contentPublishDueTask(deps: { pool: DataPool }): ScheduledTask {
  return { name: 'content.publish_due', intervalSeconds: 60, run: () => inTransaction(deps.pool, async trx => ({ published: await contentWorker.publishDue(trx) })) };
}

/** Local computation only; bytes, completion and worker fencing commit together in the job transaction. */
export function registerContent(registry: HandlerRegistry, render: PdfRenderer = renderLocalPdf): void {
  registry.onOutbox({ name: CONTENT_RENDER_KIND, type: 'issue.render_requested', async handle(event, context) {
    // CNT-001 emits both an admin audit outbox row and an identifiers-only domain event. Accept either shape.
    const raw = event.payload as { renderId?: unknown } | null;
    const id = event.aggregateKind === 'render_artifact' ? event.aggregateId : raw?.renderId;
    const parsed = Payload.safeParse({ renderId: id });
    if (parsed.success) await context.enqueue({ kind: CONTENT_RENDER_KIND, payload: parsed.data });
  } });
  registry.onJob({ kind: CONTENT_RENDER_KIND, mode: 'transactional', parse: Payload.parse, async run({ payload, trx, signal }) {
    const row = (await sql<{ snapshot: unknown }>`SELECT trustwork.content_render_prepare(${payload.renderId}::uuid) AS snapshot`.execute(trx)).rows[0];
    if (!row?.snapshot) return;
    let bytes: Buffer;
    try { bytes = await render(row.snapshot, signal); }
    catch {
      signal.throwIfAborted();
      // A local renderer failure has no durable external effect. Record a terminal, non-sensitive outcome.
      await sql`SELECT trustwork.content_render_fail(${payload.renderId}::uuid)`.execute(trx);
      return;
    }
    signal.throwIfAborted();
    await sql`SELECT trustwork.content_render_finish(${payload.renderId}::uuid, ${JSON.stringify(row.snapshot)}::jsonb, ${bytes}::bytea)`.execute(trx);
  } });
}
