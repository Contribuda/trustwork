import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  FakeC2paIptcAdapter,
  UnavailableC2paIptcAdapter,
} from "../../apps/api/src/modules/content/provenance/image-adapter.js";
import type { ImageProvenanceInput } from "../../packages/contracts/src/provenance.js";
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
