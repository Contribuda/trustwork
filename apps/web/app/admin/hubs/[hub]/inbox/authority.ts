import type { ConsoleDataPort } from '../../../_data/port.js';
import type { ConsoleRequest } from '../../../_data/personas.js';
import { APPROVER_PERMISSIONS, holdsAny, type CommandInput, type CommandOutcome } from '../../../_data/commands.js';
import type { ApprovalRequest } from '../../../_data/schemas.js';

export function requestInHub(request: ApprovalRequest, hubId: string): boolean {
  return request.hubId === hubId && request.scope.kind === 'hub' && request.scope.hubId === hubId;
}

/** Additional narrowing at the composition boundary; the owning adapter still evaluates the command. */
export async function inboxCommand(port: ConsoleDataPort, request: ConsoleRequest, input: CommandInput, actor: string, reconcile = false): Promise<CommandOutcome> {
  if (!request.demo || port.source !== 'fixtures' || !['approvals.decide', 'approvals.withdraw'].includes(input.command)) return { status: 'not_found' };
  const viewer = await port.viewer(request);
  const hub = input.hubSlug ? await port.hub(input.hubSlug, request) : null;
  if (!viewer || !hub || viewer.person.id !== actor) return { status: 'not_found' };
  const access = await port.access(viewer, { nodeId: hub.hub.nodeId, hubId: hub.hub.id });
  if (!access.roles.length || viewer.elevation.state !== 'elevated') return { status: 'not_found' };
  const projection = await port.approvals(hub.hub.id);
  const item = projection.requests.find((r) => r.id === input.fields.requestId && requestInHub(r, hub.hub.id));
  if (!item || (item.requestedBy !== actor && !holdsAny(access, APPROVER_PERMISSIONS[item.action]))) return { status: 'not_found' };
  if (input.expectedRevision !== hub.hub.revision) return { status: 'rejected', code: 'stale', field: null, detail: [] };
  // The fixture adapter has no writes. A read-only check can establish that no activation/persistence occurred.
  // A future live adapter must supply its own durable operation identity and reconciliation before being admitted.
  if (reconcile) return { status: 'demo_not_saved', secondPerson: null };
  return port.command(request, input);
}
