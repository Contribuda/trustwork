import type { Screen } from './screen';
import { screen as overview } from '../hubs/[hub]/_screen';
import { screen as approvals } from '../hubs/[hub]/approvals/_screen';
import { screen as help } from '../hubs/[hub]/help/_screen';
import { screen as identity } from '../hubs/[hub]/hub/identity/_screen';
import { screen as modes } from '../hubs/[hub]/hub/modes/_screen';
import { screen as modules } from '../hubs/[hub]/hub/modules/_screen';
import { screen as legal } from '../hubs/[hub]/hub/legal/_screen';
import { screen as residency } from '../hubs/[hub]/hub/residency/_screen';
import { screen as country } from '../hubs/[hub]/hub/country/_screen';
import { screen as taxonomy } from '../hubs/[hub]/hub/taxonomy/_screen';
import { screen as launch } from '../hubs/[hub]/hub/launch/_screen';

/** Every built hub console screen; sections with status `demo` in their group file must have one here (tested). */
export const SCREENS: readonly Screen[] = [overview, approvals, help, identity, modes, modules, legal, residency, country, taxonomy, launch];

export function screenFor(groupId: string, sectionId: string): Screen | null {
  return SCREENS.find((s) => s.group === groupId && s.id === sectionId) ?? null;
}
