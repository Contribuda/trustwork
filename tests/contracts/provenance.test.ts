import test from "node:test";
import assert from "node:assert/strict";
import {
  ProvenanceDeclarationSchema,
  ProvenanceConsentSchema,
  ImageProvenanceInputSchema,
  FakeImageAttachmentSchema,
  PROVENANCE_AUTOMATIC_PUBLICATION,
} from "../../packages/contracts/src/provenance.js";
const id = "11111111-1111-4111-8111-111111111111";
const binding = {
  publicationId: id,
  version: 1,
  digest: { algorithm: "trustwork-digest-1", value: "a".repeat(64) },
};
const declaration = {
  binding,
  expectedRevision: 0,
  kind: "ai_assisted",
  roles: ["editorial_writer"],
  evidence: "human_declaration",
  original: null,
  reason: "Synthetic declaration",
};
test("provenance accepts structured declarations and rejects invented runtime evidence, identity and policy", () => {
  assert.ok(ProvenanceDeclarationSchema.safeParse(declaration).success);
  for (const extra of [
    { responsiblePersonId: id },
    { autoPublish: true },
    { runtimeRunId: id },
    { author: "AI" },
  ])
    assert.equal(
      ProvenanceDeclarationSchema.safeParse({ ...declaration, ...extra })
        .success,
      false,
    );
  for (const over of [
    { evidence: "verified_runtime" },
    { roles: ["Synthetic Agent"] },
    { roles: ["editorial_writer", "editorial_writer"] },
    { kind: "none" },
    { kind: "machine_translation" },
  ])
    assert.equal(
      ProvenanceDeclarationSchema.safeParse({ ...declaration, ...over })
        .success,
      false,
    );
  assert.equal(PROVENANCE_AUTOMATIC_PUBLICATION, false);
});
test("credit consent is explicit and limited to one record, role and channels", () => {
  const consent = {
    provenanceId: id,
    role: "responsible_editor",
    credit: "Synthetic Editor",
    channels: ["web"],
    noticeVersion: "provenance.credit.v1",
    informedConsent: true,
  };
  assert.ok(ProvenanceConsentSchema.safeParse(consent).success);
  for (const over of [
    { channels: [] },
    { channels: ["public"] },
    { channels: ["web", "web"] },
    { informedConsent: false },
    { noticeVersion: "profile.v1" },
    { role: "author" },
  ])
    assert.equal(
      ProvenanceConsentSchema.safeParse({ ...consent, ...over }).success,
      false,
    );
});
test("image contract uses exact IPTC types and never treats test JSON as signed C2PA", () => {
  const input = {
    binding,
    provenanceId: id,
    assetId: id,
    assetSha256: "b".repeat(64),
    digitalSourceType: "trainedAlgorithmicMedia",
    depictsRealPerson: false,
    documentary: false,
  };
  assert.ok(ImageProvenanceInputSchema.safeParse(input).success);
  assert.ok(
    ImageProvenanceInputSchema.safeParse({
      ...input,
      digitalSourceType: "compositeWithTrainedAlgorithmicMedia",
    }).success,
  );
  for (const over of [
    { documentary: true },
    { depictsRealPerson: true },
    { digitalSourceType: "AI" },
  ])
    assert.equal(
      ImageProvenanceInputSchema.safeParse({ ...input, ...over }).success,
      false,
    );
  assert.equal(
    FakeImageAttachmentSchema.safeParse({
      format: "c2pa",
      assurance: "signed",
      c2paValid: true,
      input,
      attachmentSha256: "c".repeat(64),
    }).success,
    false,
  );
});
