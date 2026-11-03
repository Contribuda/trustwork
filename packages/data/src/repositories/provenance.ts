import { sql, type Selectable } from "kysely";
import type { Transaction } from "../pool.js";
import type {
  ProvenanceRecordTable,
  ProvenanceReviewTable,
  ProvenanceCreditConsentTable,
  ProvenanceImageTable,
} from "../schema/provenance.js";
import "../schema/provenance.js";
import {
  ProvenanceDeclarationSchema,
  ProvenanceReviewSchema,
  ProvenanceConsentSchema,
  type ProvenanceDeclaration,
  type ProvenanceReview,
  type ProvenanceConsent,
} from "../../../contracts/src/provenance.js";
import {
  ImageProvenanceRequestSchema,
  type ImageProvenanceRequest,
} from "../../../contracts/src/provenance-image.js";
import { publications, type ContentStaffContext } from "./content.js";
export interface ProvenanceContext {
  sessionId: string;
  requestId: string;
  elevationId?: string;
  reasonCode?: string;
  reasonText?: string;
}
export type ProvenanceRow = Selectable<ProvenanceRecordTable>;
async function command<T>(
  trx: Transaction,
  name: string,
  ctx: ProvenanceContext,
  input: unknown,
): Promise<T> {
  const result =
    await sql<T>`SELECT * FROM ${sql.ref(`trustwork.${name}`)}(${JSON.stringify(ctx)}::jsonb,${JSON.stringify(input)}::jsonb)`.execute(
      trx,
    );
  return result.rows[0] as T;
}
export const provenance = {
  declare(
    trx: Transaction,
    ctx: ProvenanceContext,
    input: ProvenanceDeclaration,
  ) {
    return command<ProvenanceRow>(
      trx,
      "provenance_declare",
      ctx,
      ProvenanceDeclarationSchema.parse(input),
    );
  },
  review(trx: Transaction, ctx: ProvenanceContext, input: ProvenanceReview) {
    return command<Selectable<ProvenanceReviewTable>>(
      trx,
      "provenance_review_translation",
      ctx,
      ProvenanceReviewSchema.parse(input),
    );
  },
  consent(trx: Transaction, ctx: ProvenanceContext, input: ProvenanceConsent) {
    return command<Selectable<ProvenanceCreditConsentTable>>(
      trx,
      "provenance_consent",
      ctx,
      ProvenanceConsentSchema.parse(input),
    );
  },
  async revoke(
    trx: Transaction,
    ctx: ProvenanceContext,
    id: string,
    reason: string,
  ) {
    await sql`SELECT trustwork.provenance_revoke(${JSON.stringify(ctx)}::jsonb,${id}::uuid,${reason})`.execute(
      trx,
    );
    return { consentId: id, revoked: true as const };
  },
  history(trx: Transaction, publicationId: string) {
    return trx
      .selectFrom("provenance_record")
      .selectAll()
      .where("publication_id", "=", publicationId)
      .orderBy("recorded_at")
      .orderBy("revision")
      .execute();
  },
  requestImage(trx: Transaction, ctx: ProvenanceContext, input: ImageProvenanceRequest) {
    return command<Selectable<ProvenanceImageTable>>(
      trx,
      "provenance_image_request",
      ctx,
      ImageProvenanceRequestSchema.parse(input),
    );
  },
  /** The caller's view of a publication's images: the table policy decides what they may see. */
  async images(trx: Transaction, publicationId: string) {
    const result = await sql<ImageRow>`SELECT i.id,i.provenance_id,i.digital_source_type,i.alt_text,i.status,i.failure,
      i.status='carried' AND a.scan_state='clean' AS ready
      FROM trustwork.provenance_image i LEFT JOIN trustwork.evidence_artifact a ON a.id=i.derived_asset_id
      WHERE i.publication_id=${publicationId}::uuid ORDER BY i.requested_at,i.id`.execute(trx);
    return result.rows;
  },
  /** A public image's bytes location, only while the reader is shown that exact version. */
  async imageDelivery(trx: Transaction, hubId: string, publicationId: string, imageId: string) {
    const result = await sql<ImageDelivery>`SELECT * FROM trustwork.provenance_image_delivery(${hubId}::uuid,${publicationId}::uuid,${imageId}::uuid)`.execute(trx);
    return result.rows[0];
  },
  /** Internal seam only; shared CNT schemas and renderers are integrated after CNT-003 merges. */
  async deliveryMetadata(
    trx: Transaction,
    hubId: string,
    publicationId: string,
    version: number,
    channel: "web" | "feed" | "pdf",
  ): Promise<unknown> {
    const result = await sql<{
      value: unknown;
    }>`SELECT trustwork.provenance_delivery_metadata(${hubId}::uuid,${publicationId}::uuid,${version}::integer,${channel}) AS value`.execute(
      trx,
    );
    return result.rows[0]?.value ?? null;
  },
  async requirePublishable(
    trx: Transaction,
    ctx: ProvenanceContext,
    id: string,
  ) {
    await sql`SELECT trustwork.provenance_require_publishable(${JSON.stringify(ctx)}::jsonb,${id}::uuid)`.execute(
      trx,
    );
  },
  /** Composes the real content command; does not replace its rights, licence checks or human publication decision. */
  async publish(
    trx: Transaction,
    ctx: ProvenanceContext,
    id: string,
    expectedPublicationRevision: number,
  ) {
    await this.requirePublishable(trx, ctx, id);
    const row = await trx
      .selectFrom("provenance_record")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    const staff: ContentStaffContext | null = ctx.elevationId
      ? {
          elevationId: ctx.elevationId,
          requestId: ctx.requestId,
          reasonCode: ctx.reasonCode ?? "provenance",
          reasonText: ctx.reasonText ?? "Provenance publication",
        }
      : null;
    return publications.publish(
      trx,
      staff,
      row.publication_id,
      expectedPublicationRevision,
      null,
    );
  },
};

interface ImageRow { id: string; provenance_id: string; digital_source_type: string; alt_text: string; status: 'pending' | 'carried' | 'failed'; failure: string | null; ready: boolean | null }
interface ImageDelivery { storage_key: string; sha256: string; bytes: string; media_type: string }
export interface ImageTarget {
  status: string; storage_key: string | null; bytes: string | null; source_sha256: string; media_type: string; digital_source_type: string;
  provenance_id: string; asset_id: string | null; publication_id: string; version: number; version_digest: string;
}
/** Worker entry points (trustwork_worker). */
export const provenanceWorker = {
  async imageTarget(trx: Transaction, id: string): Promise<ImageTarget | undefined> {
    const result = await sql<ImageTarget>`SELECT * FROM trustwork.provenance_image_target(${id}::uuid)`.execute(trx);
    return result.rows[0];
  },
  async imageComplete(trx: Transaction, id: string, carried: { key: string; sha256: string; bytes: number; credentials: unknown }): Promise<void> {
    await sql`SELECT trustwork.provenance_image_complete(${id}::uuid,${carried.key},${carried.sha256},${carried.bytes}::bigint,${carried.credentials === null ? null : JSON.stringify(carried.credentials)}::jsonb)`.execute(trx);
  },
  async imageFail(trx: Transaction, id: string, failure: string): Promise<void> {
    await sql`SELECT trustwork.provenance_image_fail(${id}::uuid,${failure})`.execute(trx);
  },
};
