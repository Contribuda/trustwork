import type { ConsolePermission, HubStaffRole } from '@trustwork/contracts/client';
import type { CommandInput, CommandOutcome } from './commands.js';
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

/**
 * The console's data boundary (ADM-002, docs/engine/hub-console/README.md "Data"). Pages and server actions use only
 * this port. Adapters:
 * - `fixture-adapter.ts`: synthetic, labelled fixtures in demo mode; commands are validated and authorized exactly like
 *   the real ones but change nothing ("Demo: changes are not saved");
 * - `unavailable-adapter.ts`: live mode until the backends land (ADM-001 staff authority, HUB-001 hubs, HUB-004
 *   setup, HUBC-007 wiring): there is no viewer, so every console route is "not found";
 * - a later `api-adapter.ts` (HUBC-007) calls `/v1/admin/*` with the same types.
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
  overview(hubId: string): Promise<Overview | null>;
  approvals(hubId: string): Promise<{ requests: ApprovalRequest[]; decisions: ApprovalDecision[] }>;
  legal(hubId: string): Promise<{ operator: Operator | null; documents: LegalDocument[] }>;
  residency(hubId: string): Promise<Residency | null>;
  localAdditions(hubId: string): Promise<LocalAddition[]>;
  taxonomy(hubId: string): Promise<TaxonomyTree[]>;
  brandChecks(hubId: string): Promise<Array<{ locale: string; ratio: string; passes: boolean }>>;
  /** The setup run a one-time token opens, or null (unknown, expired, or setup already finished). */
  setup(token: string): Promise<SetupRun | null>;
  command(request: ConsoleRequest, input: CommandInput): Promise<CommandOutcome>;
}
