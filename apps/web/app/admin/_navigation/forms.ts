import type { ConsolePermission } from '@trustwork/contracts/client';
import { COMMAND_PERMISSIONS, holdsAny, type CommandId } from '../_data/commands.js';
import type { ConsoleAccess } from '../_data/port.js';
import type { GroupDef } from '../_data/section-types.js';

/** Only implemented owning forms. This is navigation metadata, never a command dispatcher. */
export const FORM_DESTINATIONS = [
  { command: 'identity.save', path: 'hub/identity', fragment: 'change', label: 'editIdentity' },
  { command: 'modes.save', path: 'hub/modes', fragment: 'change-modes', label: 'editModes' },
  { command: 'legal.draft', path: 'hub/legal', fragment: 'draft', label: 'draftLegal' },
  { command: 'legal.request_activation', path: 'hub/legal', fragment: 'activate', label: 'requestLegal' },
] as const satisfies readonly { command: Exclude<CommandId, 'setup.save'>; path: string; fragment: string; label: string }[];

export function permittedForms(groups: readonly GroupDef[], access: ConsoleAccess) {
  const readable = new Set(groups.flatMap((group) => group.sections.map((section) => section.path)));
  return FORM_DESTINATIONS.filter((form) => {
    const permissions = COMMAND_PERMISSIONS[form.command];
    return readable.has(form.path) && holdsAny(access, permissions as readonly ConsolePermission[]);
  });
}

