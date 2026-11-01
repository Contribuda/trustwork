/**
 * Relative re-exports of the AGT-003 contracts (`packages/contracts/src/agent-modules.ts`) and of the engine module
 * manifests the registry loads. Like AGT-001's contracts they are not in the package entries yet (the client entry feeds
 * the browser bundles); adding them to an entry is integrator bookkeeping once the console or the assistant surface
 * reads them.
 */
export * from '../../../../../packages/contracts/src/agent-modules.js';
export { PROJECT_PLANNER_MANIFEST } from '../../../../../packages/contracts/src/plans.js';
export { PROFILE_KEEPER_MANIFEST } from '../../../../../packages/contracts/src/profiles.js';
export { REPUTATION_BUILDER_MANIFEST } from '../../../../../packages/contracts/src/reputation-builder.js';
export { TASK_MARKETPLACE_MANIFEST } from '../../../../../packages/contracts/src/tasks.js';
export { EXECUTION_EVIDENCE_MANIFEST } from '../execution/contracts.js';

export { CONSULTATION_MANIFEST } from '../../../../../packages/contracts/src/consultations.js';
