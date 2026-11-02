/**
 * The deterministic fake register adapters live in the contract (packages/contracts/src/sourced-facts.ts) so the API's
 * console fake runs and the worker's refresh compute the same observations.
 */
export { fakeRegisterObservations as fakeObservations, type FakeRegisterSubject as FakeSubject } from '../../../../../packages/contracts/src/sourced-facts.js';
