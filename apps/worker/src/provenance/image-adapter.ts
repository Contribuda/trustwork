import { createHash } from "node:crypto";
import { canonicalize } from "../../../../packages/contracts/src/common/canonical.js";
import {
  FakeImageAttachmentSchema,
  ImageProvenanceInputSchema,
  type FakeImageAttachment,
  type ImageProvenanceInput,
} from "../../../../packages/contracts/src/provenance-image.js";
import { carryDigitalSourceType } from "./xmp.js";

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

/**
 * The IPTC type goes into the file itself, always; C2PA signing follows only where an adapter is configured. A failed
 * verification stops the job, so an unverified attachment is never recorded.
 */
export async function carryImage(
  source: Uint8Array,
  mediaType: string,
  input: ImageProvenanceInput,
  adapter: C2paIptcAdapter,
): Promise<{ image: Uint8Array; credentials: FakeImageAttachment | null }> {
  const image = carryDigitalSourceType(source, mediaType, input.digitalSourceType);
  if (adapter.mode === "unavailable") return { image, credentials: null };
  const expected = { ...input, assetSha256: sha256(image) };
  const attachment = await adapter.attach(image, expected);
  if (!(await adapter.verify(attachment, expected)))
    throw new Error("provenance.image_binding_mismatch");
  return { image: attachment.image, credentials: attachment.manifest };
}
