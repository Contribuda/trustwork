/**
 * Type-only re-exports from the frozen contracts so view models can name contract enums without
 * pulling the schema runtime into client bundles.
 */
export type { CompanyPermission, ProjectStatus, PublicationStatus } from '@trustwork/contracts/client';
export type CompanyStatus = 'sourced' | 'claimed' | 'verified';
export type RunState = 'proposed' | 'authorized' | 'reserved' | 'queued' | 'executing' | 'pending' | 'succeeded' | 'failed' | 'outcomeUnknown' | 'reconciling' | 'revoked';
