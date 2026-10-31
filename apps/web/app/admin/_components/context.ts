import { notFound } from 'next/navigation';
import type { ConsolePermission } from '@trustwork/contracts/client';
import { demoModeEnabled } from '@/app/_lib/persona';
import { canRead, visibleGroups } from '../_data/access';
import type { CommandId } from '../_data/commands';
import { consolePort } from '../_data/index';
import { consoleHref, resolveConsoleRequest, type ConsoleRequest } from '../_data/personas';
import type { ConsoleAccess, ConsoleDataPort, StaffViewer } from '../_data/port';
import type { ConsoleNode, HubRecord } from '../_data/schemas';
import { GROUPS, type GroupDef, type SectionRef } from '../_data/sections';
import { localized } from './format';

export type PageSearchParams = Promise<Record<string, string | string[] | undefined>>;
export type HubParams = Promise<{ hub: string }>;

/** Everything a hub console page needs, resolved once per request on the server. */
export type HubContext = {
  request: ConsoleRequest;
  port: ConsoleDataPort;
  viewer: StaffViewer;
  node: ConsoleNode;
  record: HubRecord;
  access: ConsoleAccess;
  permissions: ReadonlySet<ConsolePermission>;
  nav: GroupDef[];
  current: SectionRef;
  now: Date;
  offline: boolean;
  hubName: { text: string; lang: string };
  /** A console link below this hub (`''` overview, `approvals`, `hub/identity`), keeping the demo persona. */
  href(path: string, extra?: Record<string, string>): string;
  /** Hidden fields of a console form for one command on this hub. */
  hidden(command: CommandId, extra?: Record<string, string>): Record<string, string>;
  can(permission: ConsolePermission): boolean;
};

export type HubResolution =
  | { kind: 'ok'; ctx: HubContext }
  | { kind: 'elevation'; ctx: HubContext }
  | { kind: 'denied'; reason: 'no_staff' | 'hub_not_covered' | 'section'; ctx: HubContext };

/** The console request of a page: demo persona and scenario only in demo mode, nothing read from the URL otherwise. */
export async function consoleRequest(searchParams: PageSearchParams): Promise<{ request: ConsoleRequest; port: ConsoleDataPort; demo: boolean }> {
  const demo = demoModeEnabled();
  const request = resolveConsoleRequest(demo ? await searchParams : undefined, demo);
  return { request, port: consolePort(demo), demo };
}

/**
 * Resolves a hub console page. Order of checks (each one narrows): no viewer or unknown hub → not found (anonymous
 * visitors and live mode without a console backend never learn more); no active staff role on this hub → denied
 * without navigation; no elevated session → the elevation gate; no read permission for the section → denied inside
 * the shell with the navigation the viewer may use.
 */
export async function resolveHub(params: HubParams, searchParams: PageSearchParams, current: SectionRef): Promise<HubResolution> {
  const { hub: slug } = await params;
  const { request, port } = await consoleRequest(searchParams);
  const viewer = await port.viewer(request);
  if (!viewer) notFound();
  const [record, node] = await Promise.all([port.hub(slug, request), port.node()]);
  if (!record || !node) notFound();
  const access = await port.access(viewer, { nodeId: record.hub.nodeId, hubId: record.hub.id });
  const permissions = new Set(access.permissions);
  const hasRole = access.roles.length > 0;
  const base = `/admin/hubs/${record.hub.slug}`;
  const ctx: HubContext = {
    request,
    port,
    viewer,
    node,
    record,
    access,
    permissions,
    nav: visibleGroups(GROUPS, permissions, hasRole),
    current,
    now: port.now(),
    offline: request.demo && request.scenario === 'offline',
    hubName: localized(record.hub.name, [record.hub.defaultLocale]),
    href: (path, extra) => consoleHref(path ? `${base}/${path}` : base, request, extra),
    hidden: (command, extra = {}) => ({
      command,
      hub: record.hub.slug,
      expectedRevision: String(record.hub.revision),
      ...(request.demo && request.persona ? { persona: request.persona } : {}),
      ...(request.demo && request.scenario !== 'default' ? { scenario: request.scenario } : {}),
      ...extra,
    }),
    can: (permission) => permissions.has(permission),
  };
  if (!hasRole) {
    const others = (await port.hubs(request)).filter((h) => h.hub.id !== record.hub.id);
    const elsewhere = (await Promise.all(others.map((h) => port.access(viewer, { nodeId: h.hub.nodeId, hubId: h.hub.id })))).some((a) => a.roles.length > 0);
    return { kind: 'denied', reason: elsewhere ? 'hub_not_covered' : 'no_staff', ctx };
  }
  if (viewer.elevation.state !== 'elevated') return { kind: 'elevation', ctx };
  if (!canRead(current.section, permissions, hasRole)) return { kind: 'denied', reason: 'section', ctx };
  return { kind: 'ok', ctx };
}
