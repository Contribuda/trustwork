/**
 * Relative re-exports of the directory slice (BE-003). The module imports its own contract and repository files
 * directly so the shared package entries (`packages/contracts/src/client.ts`, `packages/data/src/index.ts`) stay
 * untouched; adding them to those barrels is integrator bookkeeping.
 */
export * from '../../../../../packages/contracts/src/directory.js';
export { directory, directoryQueries, type DirectoryPage, type CompanyDirectoryRow, type MyProjectRow, type PersonDirectoryRow, type ProjectDirectoryRow, type PublicProjectOwnerRow } from '../../../../../packages/data/src/repositories/directory.js';
