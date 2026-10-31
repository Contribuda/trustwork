/**
 * Relative re-export of the AGT-001 contracts (`packages/contracts/src/agents.ts`). They are not in the package entries
 * yet: the client entry feeds the browser bundles (no interface reads these contracts so far, and the /app/me route sits
 * at its bundle budget), and the server entry only adds the digest and commercial modules. Adding them to an entry is
 * integrator bookkeeping once the assistant surface needs them.
 */
export * from '../../../../../packages/contracts/src/agents.js';
