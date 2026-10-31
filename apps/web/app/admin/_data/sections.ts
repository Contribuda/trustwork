import type { GroupDef, SectionDef } from './section-types.js';
import { GROUP as home } from '../hubs/[hub]/_group.home.js';
import { GROUP as hub } from '../hubs/[hub]/hub/_group.js';
import { GROUP as participants } from '../hubs/[hub]/participants/_group.js';
import { GROUP as support } from '../hubs/[hub]/support/_group.js';
import { GROUP as editorial } from '../hubs/[hub]/editorial/_group.js';
import { GROUP as data } from '../hubs/[hub]/data/_group.js';
import { GROUP as modules } from '../hubs/[hub]/modules/_group.js';
import { GROUP as trust } from '../hubs/[hub]/trust/_group.js';
import { GROUP as agents } from '../hubs/[hub]/agents/_group.js';
import { GROUP as billing } from '../hubs/[hub]/billing/_group.js';
import { GROUP as integrations } from '../hubs/[hub]/integrations/_group.js';
import { GROUP as automation } from '../hubs/[hub]/automation/_group.js';
import { GROUP as communications } from '../hubs/[hub]/communications/_group.js';
import { GROUP as federation } from '../hubs/[hub]/federation/_group.js';
import { GROUP as privacy } from '../hubs/[hub]/privacy/_group.js';
import { GROUP as staff } from '../hubs/[hub]/staff/_group.js';
import { GROUP as ops } from '../hubs/[hub]/ops/_group.js';

export type { GroupDef, GroupId, SectionDef, SectionStatus } from './section-types.js';

/** Every group of the hub console in navigation order (the section map of docs/engine/hub-console/README.md). */
export const GROUPS: readonly GroupDef[] = [home, hub, participants, support, editorial, data, modules, trust, agents, billing, integrations, automation, communications, federation, privacy, staff, ops];

export type SectionRef = { group: GroupDef; section: SectionDef };

/** Every section with its group. */
export const SECTIONS: readonly SectionRef[] = GROUPS.flatMap((group) => group.sections.map((section) => ({ group, section })));

/** The section a route below `/admin/hubs/[hub]` belongs to (`''` overview, `hub/identity`, …), or null. */
export function sectionByPath(path: string): SectionRef | null {
  const clean = path.replace(/^\/+|\/+$/g, '');
  return SECTIONS.find((ref) => ref.section.path === clean) ?? null;
}

/** The section by group and id (pages name their own section this way). */
export function sectionById(groupId: string, sectionId: string): SectionRef {
  const found = SECTIONS.find((ref) => ref.group.id === groupId && ref.section.id === sectionId);
  if (!found) throw new Error(`Unknown console section ${groupId}.${sectionId}`);
  return found;
}
