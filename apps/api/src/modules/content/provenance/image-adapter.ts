import { createHash } from "node:crypto";
import { canonicalize } from "../../../../../../packages/contracts/src/common/canonical.js";
import {
  FakeImageAttachmentSchema,
  ImageProvenanceInputSchema,
  type FakeImageAttachment,
  type ImageProvenanceInput,
} from "../../../../../../packages/contracts/src/provenance.js";

const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
export interface ImageAttachment {
  /** Original bytes are preserved. The fake attaches a sidecar, never a purported signed image. */
  image: Uint8Array;
  sidecar: Uint8Array;
  manifest: FakeImageAttachment;
}
/** Provider boundary: actual C2PA signing needs configured authority and a standards implementation. */
export interface C2paIptcAdapter {
  readonly mode: "unavailable" | "fake";
  attach(
    image: Uint8Array,
    input: ImageProvenanceInput,
  ): Promise<ImageAttachment>;
  verify(
    attachment: ImageAttachment,
    expected: ImageProvenanceInput,
  ): Promise<boolean>;
}
export class UnavailableC2paIptcAdapter implements C2paIptcAdapter {
  readonly mode = "unavailable" as const;
  async attach(): Promise<ImageAttachment> {
    throw new Error("provenance.signing_authority_unavailable");
  }
  async verify(): Promise<boolean> {
    return false;
  }
}
/** Only injection in tests selects this fake. A checksum detects substitution, not authorship or authenticity. */
export class FakeC2paIptcAdapter implements C2paIptcAdapter {
  readonly mode = "fake" as const;
  async attach(
    image: Uint8Array,
    candidate: ImageProvenanceInput,
  ): Promise<ImageAttachment> {
    const input = ImageProvenanceInputSchema.parse(candidate);
    if (sha256(image) !== input.assetSha256)
      throw new Error("provenance.image_binding_mismatch");
    const manifest = FakeImageAttachmentSchema.parse({
      format: "trustwork-provenance-test-attachment-1",
      assurance: "test_only_unsigned",
      c2paValid: false,
      input,
      attachmentSha256: sha256(canonicalize(input)),
    });
    return {
      image: Uint8Array.from(image),
      sidecar: new TextEncoder().encode(canonicalize(manifest)),
      manifest,
    };
  }
  async verify(
    attachment: ImageAttachment,
    expected: ImageProvenanceInput,
  ): Promise<boolean> {
    try {
      const wanted = await this.attach(attachment.image, expected);
      return (
        canonicalize(FakeImageAttachmentSchema.parse(attachment.manifest)) ===
          canonicalize(wanted.manifest) &&
        Buffer.from(attachment.sidecar).equals(Buffer.from(wanted.sidecar))
      );
    } catch {
      return false;
    }
  }
}

/** Attach only verified adapter output to an existing clean file bound to this publication. */
export async function attachImageProvenance(
  trx: import("../../../../../../packages/data/src/pool.js").Transaction,
  ctx: import("../../../../../../packages/data/src/repositories/provenance.js").ProvenanceContext,
  image: Uint8Array,
  input: ImageProvenanceInput,
  adapter: C2paIptcAdapter = new UnavailableC2paIptcAdapter(),
): Promise<string> {
  const attachment = await adapter.attach(image, input);
  if (!(await adapter.verify(attachment, input)))
    throw new Error("provenance.image_binding_mismatch");
  const { sql } = await import("kysely");
  const result = await sql<{
    id: string;
  }>`SELECT trustwork.provenance_attach_test_image(${JSON.stringify(ctx)}::jsonb,${JSON.stringify(FakeImageAttachmentSchema.parse(attachment.manifest))}::jsonb) AS id`.execute(
    trx,
  );
  return result.rows[0]!.id;
}
