import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import {
  carryImage,
  FakeC2paIptcAdapter,
  UnavailableC2paIptcAdapter,
} from "../../apps/worker/src/provenance/image-adapter.js";
import { readDigitalSourceType } from "../../apps/worker/src/provenance/xmp.js";
import { digitalSourceTypeUri } from "../../packages/contracts/src/provenance.js";
import type { ImageProvenanceInput } from "../../packages/contracts/src/provenance-image.js";
const bytes = Buffer.from(
  "synthetic image fixture; not generated provider output",
);
const input: ImageProvenanceInput = {
  binding: {
    publicationId: randomUUID(),
    version: 1,
    digest: { algorithm: "trustwork-digest-1", value: "a".repeat(64) },
  },
  provenanceId: randomUUID(),
  assetId: randomUUID(),
  assetSha256: createHash("sha256").update(bytes).digest("hex"),
  digitalSourceType: "trainedAlgorithmicMedia",
  depictsRealPerson: false,
  documentary: false,
};
test("C2PA signing is unavailable without a real configured authority", async () => {
  const port = new UnavailableC2paIptcAdapter();
  await assert.rejects(port.attach(), /signing_authority_unavailable/);
  assert.equal(await port.verify(), false);
});
test("fake attaches exact generated/edited IPTC type and detects byte, sidecar and binding substitution", async () => {
  const port = new FakeC2paIptcAdapter();
  for (const digitalSourceType of [
    "trainedAlgorithmicMedia",
    "compositeWithTrainedAlgorithmicMedia",
  ] as const) {
    const expected = { ...input, digitalSourceType };
    const artifact = await port.attach(bytes, expected);
    assert.equal(await port.verify(artifact, expected), true);
    assert.equal(artifact.manifest.c2paValid, false);
    assert.equal(artifact.manifest.assurance, "test_only_unsigned");
    assert.deepEqual(artifact.image, Uint8Array.from(bytes));
    assert.equal(
      await port.verify(
        { ...artifact, image: Buffer.from("tampered") },
        expected,
      ),
      false,
    );
    assert.equal(
      await port.verify({ ...artifact, sidecar: Buffer.from("{}") }, expected),
      false,
    );
    for (const substitution of [
      { ...expected, assetId: randomUUID() },
      { ...expected, provenanceId: randomUUID() },
      { ...expected, binding: { ...expected.binding, version: 2 } },
      {
        ...expected,
        digitalSourceType:
          digitalSourceType === "trainedAlgorithmicMedia"
            ? "compositeWithTrainedAlgorithmicMedia"
            : "trainedAlgorithmicMedia",
      },
    ] as ImageProvenanceInput[])
      assert.equal(await port.verify(artifact, substitution), false);
  }
});
test("the IPTC type is carried without any signer; a configured adapter signs the labelled bytes, never the source", async () => {
  const source = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 9, g: 9, b: 9 } } }).png().toBuffer();
  const request = { ...input, assetSha256: createHash("sha256").update(source).digest("hex") };
  const unsigned = await carryImage(source, "image/png", request, new UnavailableC2paIptcAdapter());
  assert.equal(unsigned.credentials, null);
  assert.equal(readDigitalSourceType(unsigned.image, "image/png"), digitalSourceTypeUri("trainedAlgorithmicMedia"));
  const signed = await carryImage(source, "image/png", request, new FakeC2paIptcAdapter());
  assert.equal(readDigitalSourceType(signed.image, "image/png"), digitalSourceTypeUri("trainedAlgorithmicMedia"));
  assert.equal(signed.credentials?.c2paValid, false);
  assert.equal(signed.credentials?.input.assetSha256, createHash("sha256").update(signed.image).digest("hex"));
  const lying = new FakeC2paIptcAdapter();
  lying.verify = async () => false;
  await assert.rejects(carryImage(source, "image/png", request, lying), /image_binding_mismatch/);
});
