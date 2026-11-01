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
// HUBC-004: participants, support, trust and safety.
import { screen as people } from '../hubs/[hub]/participants/people/_screen';
import { screen as companies } from '../hubs/[hub]/participants/companies/_screen';
import { screen as claims } from '../hubs/[hub]/participants/claims/_screen';
import { screen as verification } from '../hubs/[hub]/participants/verification/_screen';
import { screen as credentials } from '../hubs/[hub]/participants/credentials/_screen';
import { screen as consents } from '../hubs/[hub]/participants/consents/_screen';
import { screen as supportLookup } from '../hubs/[hub]/support/_screen';
import { screen as supportCases } from '../hubs/[hub]/support/cases/_screen';
import { screen as supportRecovery } from '../hubs/[hub]/support/recovery/_screen';
import { screen as supportExplain } from '../hubs/[hub]/support/explain/_screen';
import { screen as moderation } from '../hubs/[hub]/trust/moderation/_screen';
import { screen as disputes } from '../hubs/[hub]/trust/disputes/_screen';
import { screen as reputation } from '../hubs/[hub]/trust/reputation/_screen';
import { screen as appeals } from '../hubs/[hub]/trust/appeals/_screen';
import { screen as screening } from '../hubs/[hub]/trust/screening/_screen';
import { screen as confirmations } from '../hubs/[hub]/trust/confirmations/_screen';

/** Every built hub console screen; sections with status `demo` in their group file must have one here (tested). */
export const SCREENS: readonly Screen[] = [
  overview, approvals, help, identity, modes, modules, legal, residency, country, taxonomy, launch,
  // HUBC-004
  people, companies, claims, verification, credentials, consents, supportLookup, supportCases, supportRecovery, supportExplain,
  moderation, disputes, reputation, appeals, screening, confirmations,
];

export function screenFor(groupId: string, sectionId: string): Screen | null {
  return SCREENS.find((s) => s.group === groupId && s.id === sectionId) ?? null;
}
