import { sql, type Selectable } from "kysely";
import type { Transaction } from "../pool.js";
import type {
  ProvenanceRecordTable,
  ProvenanceReviewTable,
  ProvenanceCreditConsentTable,
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
