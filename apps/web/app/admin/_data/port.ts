import type { ConsolePermission, HubStaffRole, StaffScopeKind } from '@trustwork/contracts/client';
import type { StaffDirectory } from '../../../../../packages/contracts/src/staff-lifecycle.js';
import type { CommandInput, CommandOutcome, ReadyApproval, WaitingActivation } from './commands.js';
import type { ConsoleRequest } from './personas.js';
import type {
  ApprovalDecision,
  ApprovalRequest,
  ConsoleNode,
  ConsolePerson,
  HubRecord,
  LegalDocument,
  LocalAddition,
  Operator,
  Overview,
  Residency,
  SetupRun,
  TaxonomyTree,
} from './schemas.js';
import type { SectionDef } from './section-types.js';
import type { HubProduct } from '../hubs/[hub]/modules/_kit/schemas.js';

/**
 * The console's data boundary (ADM-002, docs/engine/hub-console/README.md "Data"). Pages and server actions use only
 * this port. Adapters:
 * - `fixture-adapter.ts`: synthetic, labelled fixtures in demo mode; commands are validated and authorized exactly like
 *   the real ones but change nothing ("Demo: changes are not saved");
 * - `unavailable-adapter.ts`: a deployment with no API origin: there is no viewer, so every console route is "not found";
 * - `api-adapter.ts` (HUBC-007) calls `/v1/admin/*` with the same types.
 * Every method is asynchronous; failures arrive as rejections.
 */

export type ElevationState = { state: 'elevated'; until: string } | { state: 'required' };

/** The signed-in person on the console with their session elevation. Null from `viewer()` means "not found". */
export type StaffViewer = { person: ConsolePerson; elevation: ElevationState };

/** What a viewer holds on a target: roles and the permissions of their released definitions. */
export type ConsoleAccess = { roles: HubStaffRole[]; permissions: ConsolePermission[] };

export type ConsoleDataSource = 'fixtures' | 'unavailable' | 'api';

export interface ConsoleDataPort {
  readonly source: ConsoleDataSource;
  /** The instant states are computed against (the fixture clock in demo mode, the server clock otherwise). */
  now(): Date;
  viewer(request: ConsoleRequest): Promise<StaffViewer | null>;
  node(): Promise<ConsoleNode | null>;
  hubs(request: ConsoleRequest): Promise<HubRecord[]>;
  hub(slug: string, request: ConsoleRequest): Promise<HubRecord | null>;
  access(viewer: StaffViewer, target: { nodeId: string; hubId: string | null }): Promise<ConsoleAccess>;
  rolesGranting(section: SectionDef): Promise<HubStaffRole[]>;
  people(ids: readonly string[]): Promise<ConsolePerson[]>;
  /**
   * The staff covering the hub (HC-150, ADM-004 directory): names for every staff viewer; roles and second-factor state
   * only when the viewer holds `admin.staff.read` (`detail`). The live API decides that itself; the fixture adapter
   * follows `detail`. Null when the hub is not readable.
   */
  staff(hubId: string, detail: boolean): Promise<StaffDirectory | null>;
  /** What one staff member may do at the hub now (roles and permissions); null when not readable. */
  effectiveAccess(hubId: string, personId: string): Promise<{ roles: HubStaffRole[]; permissions: ConsolePermission[] } | null>;
  /** The released role definitions a staff admin may assign: the latest version of each role with its scopes. */
  roleCatalogue(): Promise<Array<{ role: HubStaffRole; version: number; scopes: StaffScopeKind[] }>>;
  overview(hubId: string): Promise<Overview | null>;
  /**
   * Requests and decisions; the live adapter also lists the viewer's approved changes that wait to be applied (`ready`)
   * and the sensitive drafts that wait for someone to request their activation (`waiting`).
   */
  approvals(hubId: string): Promise<{ requests: ApprovalRequest[]; decisions: ApprovalDecision[]; ready?: ReadyApproval[]; waiting?: WaitingActivation[] }>;
  legal(hubId: string): Promise<{ operator: Operator | null; documents: LegalDocument[] }>;
  residency(hubId: string): Promise<Residency | null>;
  localAdditions(hubId: string): Promise<LocalAddition[]>;
  taxonomy(hubId: string): Promise<TaxonomyTree[]>;
  brandChecks(hubId: string): Promise<Array<{ locale: string; ratio: string; passes: boolean }>>;
  /** The agent product, product modules, billing and communications of a hub (HUBC-005), or null. */
  product(hubId: string): Promise<HubProduct | null>;
  /** The setup run a one-time token opens, or null (unknown, expired, or setup already finished). */
  setup(token: string): Promise<SetupRun | null>;
  command(request: ConsoleRequest, input: CommandInput): Promise<CommandOutcome>;
}
