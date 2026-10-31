-- trustwork:expect-rows 8
-- BILL-001: the meter vocabulary of the agent catalogue (MeterSchema in packages/contracts/src/agent-catalog.ts). Units
-- are the raw units counted; prices per thousand units are meter_rate_version rows a hub drafts and a second person
-- activates. Descriptions are locale keys, never text.
INSERT INTO trustwork.meter (code, unit, description_key) VALUES
  ('model_tokens', 'token', 'billing.meter.modelTokens'),
  ('agent_actions', 'action', 'billing.meter.agentActions'),
  ('checks', 'check', 'billing.meter.checks'),
  ('document_pages', 'page', 'billing.meter.documentPages'),
  ('deliverables', 'deliverable', 'billing.meter.deliverables'),
  ('translation_characters', 'character', 'billing.meter.translationCharacters'),
  ('retrieval_queries', 'query', 'billing.meter.retrievalQueries'),
  ('external_calls', 'call', 'billing.meter.externalCalls');
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
