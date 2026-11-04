import type { ErrorCode } from '../../../deps/contracts.js';
import { ApiError } from '../../../common/errors.js';
import { FEDERATION_ERROR_STATUS, FederationErrorSchema, MESH_PROTOCOL, type FederationError, type FederationErrorCode } from './deps.js';

/**
 * Refusals of the federation node commands (SQLSTATE plus a hint) as contract error codes for the console, and the
 * protocol's own error envelope for the mesh endpoints. Existence never leaks: `admin.not_found` is `access.not_found`.
 */
const HINTS: Readonly<Record<string, ErrorCode>> = {
  'admin.not_found': 'access.not_found',
  'admin.forbidden': 'access.forbidden',
  'admin.elevation_required': 'access.forbidden',
  'access.no_principal': 'access.forbidden',
  'admin.self_approval': 'access.second_approver_required',
  'admin.approval_required': 'access.approval_required',
  'admin.approval_expired': 'access.approval_required',
  'admin.approval_consumed': 'access.approval_required',
  'admin.approval_not_approved': 'access.approval_required',
  'admin.not_requester': 'access.approval_required',
  'admin.approval_mismatch': 'access.approval_digest_mismatch',
  'admin.context_invalid': 'validation.schema',
  'admin.immutable': 'validation.schema',
  'audit.append_only': 'validation.schema',
  'validation.not_canonicalizable': 'validation.not_canonicalizable',
  'federation.no_node': 'validation.schema',
  'federation.no_identity': 'validation.schema',
  'federation.identity_exists': 'validation.revision_conflict',
  'federation.restricted_place': 'validation.schema',
  'federation.host_invalid': 'validation.schema',
  'federation.context_invalid': 'validation.schema',
  'federation.chain_order': 'validation.schema',
  'federation.handover_gap': 'validation.schema',
  'federation.not_current_key': 'validation.revision_conflict',
  'federation.rotation_time': 'validation.schema',
  'federation.compromise_time': 'validation.schema',
  'federation.revision_conflict': 'validation.revision_conflict',
  'federation.invalid_transition': 'validation.revision_conflict',
  'federation.ended': 'validation.revision_conflict',
  'federation.self_peering': 'validation.schema',
  'federation.level_not_offered': 'validation.schema',
  'federation.level_above_request': 'validation.schema',
  'federation.peer_restricted': 'access.forbidden',
  'federation.unknown_peer': 'access.not_found',
  'federation.unknown_hub': 'access.not_found',
  'federation.subject_is_address': 'validation.schema',
  'federation.manifest_rollback': 'validation.revision_conflict',
  'federation.signer_only': 'access.forbidden',
  'kernel.restricted_place': 'validation.schema',
};

interface PgError { code?: string; hint?: string; detail?: string; constraint?: string }

/** The contract error for a database refusal, or null when the error is not one of these refusals. */
export function federationRefusal(error: unknown): ApiError | null {
  if (error instanceof ApiError) return error;
  const pg = error as PgError | null;
  if (!pg || typeof pg.code !== 'string') return null;
  if (pg.code === '23503') return new ApiError('validation.schema', 'validation.schema', { reason: 'unknown_reference' });
  if (pg.code === '23505' && !pg.hint) return new ApiError('validation.revision_conflict', 'validation.revision_conflict', { reason: pg.constraint === 'peering_record_one_open' ? 'peering_exists' : 'duplicate' });
  if (pg.code === '23514' && !pg.hint) return new ApiError('validation.schema', 'validation.schema', { reason: 'constraint', constraint: pg.constraint ?? null });
  if (typeof pg.hint !== 'string') return null;
  const code = HINTS[pg.hint];
  if (!code) return null;
  const reason = pg.hint.replace(/^(admin|access|validation|federation|kernel|audit)\./, '');
  const items = pg.detail ? pg.detail.split(',').filter(Boolean) : undefined;
  return new ApiError(code, code, { reason, ...(items ? { items } : {}), ...(pg.hint === 'admin.elevation_required' ? { required: 'elevation' } : pg.hint === 'admin.forbidden' ? { required: 'permission' } : {}) });
}

/** Refusals of authority that are recorded as `denied` audit rows (not shape errors or missing objects). */
export function isAuthorityRefusal(refusal: ApiError): boolean {
  return ['access.forbidden', 'access.second_approver_required', 'access.approval_required', 'access.approval_digest_mismatch'].includes(refusal.code);
}

/** A refusal on a mesh endpoint: rendered as the protocol's error envelope with its fixed status (section 17). */
export class FederationProtocolError extends Error {
  constructor(readonly code: FederationErrorCode, message: string = code) {
    super(message);
    this.name = 'FederationProtocolError';
  }
  get status(): number {
    return FEDERATION_ERROR_STATUS[this.code];
  }
  body(requestId: string): FederationError {
    return FederationErrorSchema.parse({ protocol: MESH_PROTOCOL, code: this.code, message: this.message.slice(0, 500), requestId });
  }
}

/**
 * The node cannot judge an outbound address: the configured jurisdiction gate (SANC-001) answers for inbound requests
 * only (`edge_header`, `upstream_gate`) or is not configured. Federation fails closed: no peer is contacted until an
 * address-judging gate (`TRUSTWORK_JURISDICTION_GATE=ranges_file`) is configured. No provider, account or external call.
 */
export class FederationConfigurationError extends Error {
  constructor(readonly gateMode: string) {
    super(`address judgement must be configured before federation goes live: the ${gateMode} jurisdiction gate cannot judge an outbound address; set TRUSTWORK_JURISDICTION_GATE=ranges_file`);
    this.name = 'FederationConfigurationError';
  }
}
