/**
 * WEB-006 type test, compiled by `data-port.test.ts` with this directory's tsconfig (the web app's compiler
 * settings and `@/` paths). It is a `.tsx` file so the root `tsc` (Node resolution, no `@/` paths) skips it.
 * Every `@ts-expect-error` below must still be an error, so the negative cases are checked too.
 */
import { data, type DataPort, type HomeView, type PersonDetail } from '@/app/_lib/data';
import { fixtureDataPort } from '@/app/_lib/data/fixture-adapter';
import { httpDataPort } from '@/app/_lib/data/http';

type Assert<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// 1. The fixture adapter satisfies the port, and the boundary hands pages exactly the port type.
export const adapter: DataPort = fixtureDataPort;
// The live API adapter (WEB-004) satisfies the same port and adds nothing either.
export const live: DataPort = httpDataPort;
export type LiveNoExtraMembers = Assert<Equal<Exclude<keyof typeof httpDataPort, keyof DataPort>, never>>;
export type BoundaryIsThePort = Assert<Equal<typeof data, DataPort>>;

// 2. The adapter adds nothing beyond the port (pages cannot reach fixture-only helpers through it).
export type NoExtraMembers = Assert<Equal<Exclude<keyof typeof fixtureDataPort, keyof DataPort>, never>>;

// 3. Every data function of the port is asynchronous: 31 methods (getLegalDocuments added by QA-002 D4), each returning a Promise.
type Method = { [K in keyof DataPort]: DataPort[K] extends (...args: never[]) => unknown ? K : never }[keyof DataPort];
type Returns = { [K in Method]: DataPort[K] extends (...args: never[]) => infer R ? R : never };
export type AllAsync = Assert<Equal<{ [K in Method]: Returns[K] extends Promise<unknown> ? true : false }[Method], true>>;
type UnionLength<U, Acc extends unknown[] = []> = [U] extends [never] ? Acc['length'] : UnionLength<Exclude<U, LastOf<U>>, [...Acc, LastOf<U>]>;
type LastOf<U> = ((U extends unknown ? (x: () => U) => void : never) extends (x: infer I) => void ? I : never) extends () => infer L ? L : never;
export type ThirtyOneMethods = Assert<Equal<UnionLength<Method>, 31>>;

// 4. Public entities are looked up by handle, workspace objects by id (parameter names are part of the contract docs; types are strings).
export type PersonByHandle = Assert<Equal<Parameters<DataPort['getPerson']>, [handle: string]>>;
export type ProjectById = Assert<Equal<Parameters<DataPort['getWorkspaceProject']>[1], string>>;
export type PersonCarriesHandle = Assert<Equal<PersonDetail['handle'], string>>;

// Negative cases: a synchronous adapter, a missing method and a slug-shaped view model are rejected.
export const syncAdapter: DataPort = {
  ...fixtureDataPort,
  // @ts-expect-error a synchronous data function does not satisfy the port
  getHome: (): HomeView => ({}) as HomeView,
};
declare const withoutGetPerson: Omit<DataPort, 'getPerson'>;
// @ts-expect-error an adapter without getPerson does not satisfy the port
export const missingMethod: DataPort = withoutGetPerson;
// @ts-expect-error view models expose `handle`, not `slug`, for people
export const slugField: PersonDetail['slug'] = '';
