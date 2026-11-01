/** First-party human decisions only. No agent/MCP execution grant or publication policy is registered. */
export const PROVENANCE_OPERATIONS = [
  {
    action: "provenance.declare",
    route: "POST /v1/provenance/declarations",
    actor: "first_party_person",
    input: "ProvenanceDeclarationSchema",
    sideEffect: "append_provenance",
  },
  {
    action: "provenance.review",
    route: "POST /v1/provenance/reviews",
    actor: "first_party_person",
    input: "ProvenanceReviewSchema",
    sideEffect: "append_exact_review",
  },
  {
    action: "provenance.consent",
    route: "POST /v1/provenance/consents",
    actor: "first_party_person",
    input: "ProvenanceConsentSchema",
    sideEffect: "grant_exact_credit_consent",
  },
  {
    action: "provenance.revoke",
    route: "POST /v1/provenance/revocations",
    actor: "first_party_person",
    input: "ProvenanceRevokeSchema",
    sideEffect: "revoke_exact_credit_consent",
  },
] as const;
