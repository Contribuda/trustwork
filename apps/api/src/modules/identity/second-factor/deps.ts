/**
 * Relative re-exports of the BE-004 contract and data slices (the shared package entries are integrator bookkeeping;
 * the API build compiles these sources into its own dist, like `deps/contracts.ts` and `deps/data.ts`).
 */
export * from '../../../../../../packages/contracts/src/second-factor.js';
export {
  secondFactors, recoveryCodes, secondFactorChallenges, sessionElevations, secondFactorResets, clearOwnSecondFactorFailures, SecondFactorResetRefused, type OpenChallenge,
} from '../../../../../../packages/data/src/repositories/identity.js';
export type { SecondFactorRow, SessionElevationRow, SecondFactorResetRow } from '../../../../../../packages/data/src/schema/identity.js';
