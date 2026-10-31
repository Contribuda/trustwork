/**
 * Type-only re-exports from the frozen contracts so view models can name contract enums without
 * pulling the schema runtime into client bundles.
 */
export type { CompanyPermission, ProjectStatus, PublicationStatus } from '@trustwork/contracts/client';
/** Contract record states plus `registered`: created on the platform by its administrator, neither sourced nor claimed (BE-003). */
export type CompanyStatus = 'registered' | 'sourced' | 'claimed' | 'verified';
export type RunState = 'proposed' | 'authorized' | 'reserved' | 'queued' | 'executing' | 'pending' | 'succeeded' | 'failed' | 'outcomeUnknown' | 'reconciling' | 'revoked';
