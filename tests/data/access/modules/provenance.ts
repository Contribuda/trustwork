import type { AccessInventory } from "../inventory.js";
export default {
  package: "PROV-001",
  forcedTables: [
    "provenance_record",
    "provenance_review",
    "provenance_credit_consent",
    "provenance_credit_revocation",
    "provenance_image_attachment",
  ],
  apiDefiners: [
    "provenance_workspace",
    "provenance_prepare_correction",
    "provenance_declare",
    "provenance_review_translation",
    "provenance_consent",
    "provenance_revoke",
    "provenance_delivery_metadata",
    "provenance_require_publishable",
    "provenance_attach_test_image",
  ],
  workerDefiners: [],
} satisfies AccessInventory;
