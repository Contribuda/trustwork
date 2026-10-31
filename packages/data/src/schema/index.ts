import type { FoundationDatabase } from './foundation.js';

/**
 * Hand-written Kysely model of the `trustwork` schema, split per module so parallel slices never edit a shared file.
 *
 * - `./foundation.ts` mirrors the tables created by the flat-root migrations.
 * - A slice that owns `packages/data/migrations/<module>/` adds `./<module>.ts`, exporting its table interfaces, a
 *   `<Module>Database` interface, `TABLE_COLUMNS` (built with `columnsOf`) and a module augmentation that merges its
 *   tables into `Database` below:
 *
 *   ```ts
 *   declare module './index.js' { interface Database extends PlansDatabase {} }
 *   ```
 *
 *   Its repository (`packages/data/src/repositories/<module>.ts`) imports `./schema/<module>.js`, which brings the
 *   augmentation into every program that uses the repository. This index does not import module files.
 * - tests/data/migrations.test.ts lists this directory and compares the union of every file's `TABLE_COLUMNS` with
 *   information_schema, so a table without a mirror (or a mirror without a table) fails the gate.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- extended by module augmentation, see above
export interface Database extends FoundationDatabase {}

export * from './foundation.js';
export { TABLE_COLUMNS as FOUNDATION_COLUMNS } from './foundation.js';
