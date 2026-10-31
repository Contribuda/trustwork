import type { Principal } from '../../../deps/contracts.js';
import { withPrincipal, type Transaction } from '../../../deps/data.js';
import { ApiError } from '../../../common/errors.js';
import type { RequestState } from '../../../common/request.js';
import type { AppContext } from '../../identity/context.js';
import type { PrincipalService } from '../../identity/principal.service.js';
import { loadRestrictedPlaces } from '../gate.js';
import {
  deploymentAttestations, deploymentAttestationStatus, DeploymentAttestationStatusSchema, DeploymentLocationAttestationSchema, DeploymentLocationAttestationSummarySchema,
  type AttestDeploymentLocationCommand, type DeploymentAttestationStatus, type DeploymentConfiguration, type DeploymentLocationAttestation, type DeploymentLocationAttestationRow,
  type DeploymentLocationAttestationSummary, type DeploymentLocationAttestationSummaryRow, type JurisdictionGateMode,
} from './deps.js';

const iso = (d: Date): string => d.toISOString();
export function summaryView(row: DeploymentLocationAttestationSummaryRow): DeploymentLocationAttestationSummary {
  return DeploymentLocationAttestationSummarySchema.parse({
    id: row.id, nodeId: row.node_id, operatorEntityCountry: row.operator_entity_country, operatorEntityRegion: row.operator_entity_region, hostingCountry: row.hosting_country,
    hostingRegion: row.hosting_region, gateMode: row.gate_mode, statementDigest: row.statement_digest, attestedAt: iso(row.attested_at), expiresAt: iso(row.expires_at),
    supersedesId: row.supersedes_id, basis: 'operator_statement',
  });
}
export function attestationView(row: DeploymentLocationAttestationRow): DeploymentLocationAttestation {
  return DeploymentLocationAttestationSchema.parse({
    id: row.id, nodeId: row.node_id, operatorEntityCountry: row.operator_entity_country, operatorEntityRegion: row.operator_entity_region, hostingCountry: row.hosting_country,
    hostingRegion: row.hosting_region, gateMode: row.gate_mode, statementVersion: row.statement_version, statementDigest: row.statement_digest, attestedBy: row.attested_by,
    attesterRole: row.attester_role, permission: row.permission, sessionElevationId: row.session_elevation_id, breakglass: row.breakglass, attestedAt: iso(row.attested_at),
    expiresAt: iso(row.expires_at), supersedesId: row.supersedes_id, basis: 'operator_statement',
  });
}

interface PgError { code?: string; hint?: string; detail?: string }
const hintOf = (error: unknown): string | undefined => (error as PgError)?.hint;
const AUTHORITY_HINTS = new Set(['admin.forbidden', 'admin.elevation_required', 'admin.context_invalid', 'access.no_principal']);
const refusalsOf = (detail: string | undefined) => (detail ?? '').split(',').filter(Boolean).map((entry) => {
  const [field, place, reason] = entry.split(':');
  return { field, place, reason };
});

/** Database refusals of the attest command as contract codes (`details.reason` carries the database reason). */
function attestRefusal(error: unknown): ApiError | null {
  const hint = hintOf(error);
  if (!hint) return null;
  if (AUTHORITY_HINTS.has(hint)) return new ApiError('access.forbidden', 'only node or platform staff holding an attesting permission, under an elevation, attest the deployment location', { reason: hint });
  if (hint === 'attestation.restricted_place') return new ApiError('validation.schema', 'a restricted place cannot be attested', { reason: 'restricted_place', refusals: refusalsOf((error as PgError).detail) });
  if (hint === 'attestation.region_required') return new ApiError('validation.schema', 'state the region for a country whose regions the restricted list distinguishes', { reason: 'region_required', refusals: refusalsOf((error as PgError).detail) });
  if (hint === 'attestation.stale') return new ApiError('validation.revision_conflict', 'the current attestation is not the one named in supersedes', { reason: 'stale', current: (error as PgError).detail === 'none' ? null : (error as PgError).detail });
  if (hint === 'attestation.no_node') return new ApiError('validation.schema', 'the node is not set up yet', { reason: 'no_node' });
  if (hint === 'attestation.restricted_list_unsynced') return new ApiError('validation.schema', 'the restricted places are not synced; nothing can be attested', { reason: 'restricted_list_unsynced' });
  if (hint === 'attestation.invalid_place' || hint === 'attestation.invalid_gate_mode' || hint === 'attestation.statement_version') return new ApiError('validation.schema', 'the statement is not well formed', { reason: hint.slice('attestation.'.length) });
  return null;
}

/**
 * Deployment-location attestation use cases (SANC-009, ADR 014 decisions 3 to 5).
 *
 * - `status`: the current attestation (without the attesting person) judged against the clock, the current restricted
 *   list and this process's configured jurisdiction gate; what the console, the launch gate and other services read.
 * - `attest`: one request transaction as the staff member through `attestation_attest`, which checks the permission at
 *   the node, the elevation, the places and the predecessor and writes the audit row (BE-005 completes there too). A
 *   refused place leaves a `denied` audit row written in its own transaction after the rollback.
 */
export class AttestationService {
  constructor(
    private readonly ctx: AppContext,
    private readonly principals: PrincipalService,
    private readonly configuration: () => DeploymentConfiguration,
  ) {}

  /** The status at the application clock, for any reader holding a transaction (or the pool). */
  async statusOf(summary: DeploymentLocationAttestationSummary | null): Promise<DeploymentAttestationStatus> {
    const restricted = await loadRestrictedPlaces(this.ctx.pool);
    return DeploymentAttestationStatusSchema.parse(deploymentAttestationStatus(summary, { now: this.ctx.clock.now(), restricted, configuration: this.configuration() }));
  }

  /** The status without a principal (launch gate of HUB-004, node manifest of FED-001, services of SANC-008). */
  async currentStatus(): Promise<DeploymentAttestationStatus> {
    const row = await deploymentAttestations.currentOnPool(this.ctx.pool);
    return this.statusOf(row ? summaryView(row) : null);
  }

  status(state: RequestState): Promise<DeploymentAttestationStatus> {
    return this.principals.runAs(state, async (trx) => {
      const row = await deploymentAttestations.current(trx);
      return this.statusOf(row ? summaryView(row) : null);
    });
  }

  history(state: RequestState): Promise<{ items: DeploymentLocationAttestation[] }> {
    return this.principals.runAs(state, async (trx) => ({ items: (await deploymentAttestations.history(trx)).map(attestationView) }));
  }

  async attest(state: RequestState, elevationId: string, body: AttestDeploymentLocationCommand): Promise<{ attestation: DeploymentLocationAttestation; status: DeploymentAttestationStatus }> {
    const cmd = { elevationId, requestId: state.requestId, reasonCode: 'deployment_location_attested', reasonText: body.reason };
    const input = { operatorEntityCountry: body.operatorEntityCountry, operatorEntityRegion: body.operatorEntityRegion, hostingCountry: body.hostingCountry, hostingRegion: body.hostingRegion, gateMode: body.gateMode };
    try {
      return await this.principals.runAs(state, async (trx: Transaction) => {
        const row = await deploymentAttestations.attest(trx, cmd, { ...input, supersedes: body.supersedes, statementVersion: body.statementVersion });
        const attestation = attestationView(row);
        const current = await deploymentAttestations.current(trx);
        return { attestation, status: await this.statusOf(current ? summaryView(current) : null) };
      });
    } catch (error) {
      const refusal = attestRefusal(error);
      const hint = hintOf(error);
      if (hint === 'attestation.restricted_place' || hint === 'attestation.region_required') {
        const p = state.principal as Principal;
        await withPrincipal(this.ctx.pool, { personId: p.personId, authzEpoch: p.authzEpoch }, (trx) => deploymentAttestations.recordRefusal(trx, cmd, input))
          .catch((failure: unknown) => this.ctx.log('attestation.denied_audit_failed', failure));
      }
      throw refusal ?? error;
    }
  }
}

export type ConfiguredGateMode = JurisdictionGateMode | 'unconfigured';
