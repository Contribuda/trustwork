// Shared by scripts/export-open-source.mjs and scripts/work-packages.mjs so the public work list never points into private paths.
/** Paths that belong to this deployment or to the owner's working process, not to the engine. */
export const EXCLUDES = [
  // owner evidence, research archive, deployment infrastructure
  'docs/evidence',
  'docs/design/references',
  'docs/design/manifest.json',
  'docs/design/screen-contracts/reference-inspection.md',
  'docs/design/system/showcase',
  'tests/web/__screenshots__',
  'docs/operations',
  'docs/research',
  'docs/integrations',
  'docs/adr/005-delivery-coordination.md',
  'docs/adr/006-contribuddha-and-orbit.md',
  'docs/product/open-decisions.md',
  'docs/product/traceability.json',
  'infra/railway',
  // agent coordination and task bookkeeping of the private repository
  'tasks',
  'docs/agents',
  'AGENTS.md',
  'CLAUDE.md',
  'CODEX.md',
  'FABLE.md',
  'apps/web/AGENTS.md',
  'scripts/coordination.mjs',
  'scripts/task-graph.mjs',
  'scripts/record-check.mjs',
  'tests/coordination.test.mjs',
  'tests/contracts/access-admin-capability-map.test.ts',
  'tests/tooling.test.mjs',
  '.github/workflows',
  '.claude',
  // the reference deployment's brand (replaced by the engine's neutral Trustwork lockup)
  'apps/web/brand',
];
