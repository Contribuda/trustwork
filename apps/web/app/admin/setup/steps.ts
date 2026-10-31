import { SETUP_STEPS } from '@trustwork/contracts/client';

/** URL slugs of the wizard steps (`/admin/setup/[step]`) and their contract names (`SETUP_STEPS`). Locale keys use the slug. */
export const STEP_SLUGS = {
  install_check: 'check',
  node_identity: 'node',
  hub_identity: 'hub',
  operator: 'operator',
  first_admin: 'admin',
  storage_residency: 'residency',
  providers: 'providers',
  modes: 'modes',
  review: 'review',
} as const satisfies Record<(typeof SETUP_STEPS)[number], string>;

export type SetupStep = (typeof SETUP_STEPS)[number];
export type StepSlug = (typeof STEP_SLUGS)[SetupStep];

export function stepFromSlug(slug: string): SetupStep | null {
  return (SETUP_STEPS.find((step) => STEP_SLUGS[step] === slug) as SetupStep | undefined) ?? null;
}

export function setupHref(step: SetupStep, token: string, extra: Record<string, string> = {}): string {
  return `/admin/setup/${STEP_SLUGS[step]}?${new URLSearchParams({ token, ...extra }).toString()}`;
}
