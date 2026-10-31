import type { ConsolePermission } from '@trustwork/contracts/client';

/**
 * Navigation of the hub console (docs/engine/hub-console/README.md, "Hub console section map"). Each group is declared
 * in its own folder (`hubs/[hub]/<group>/_group.ts`) so the package that builds a section flips its `status` in its
 * own path instead of editing a shared file.
 *
 * - `read`: the section is visible to a viewer holding any of these permissions; `'staff'` means any active staff role.
 * - `status`: `demo` when the screen is built on synthetic fixtures (ADM-002), `designed` when only the handbook
 *   describes it; designed sections render an honest "not built yet" page instead of an imitation.
 * - `screen`: the screen id in docs/engine/hub-console/screens.md.
 */
export type SectionStatus = 'demo' | 'designed';
export type SectionDef = {
  id: string;
  /** Route below `/admin/hubs/[hub]` (`''` is the overview). */
  path: string;
  read: 'staff' | readonly ConsolePermission[];
  status: SectionStatus;
  screen: string;
};
export const GROUP_IDS = [
  'home', 'hub', 'participants', 'support', 'editorial', 'data', 'modules', 'trust', 'agents', 'billing', 'integrations', 'automation',
  'communications', 'federation', 'privacy', 'staff', 'ops',
] as const;
export type GroupId = (typeof GROUP_IDS)[number];
export type GroupDef = { id: GroupId; sections: readonly SectionDef[] };
