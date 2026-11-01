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
// HUBC-005: product modules, agent product, billing and communications.
import { screen as modulesProjects } from '../hubs/[hub]/modules/projects/_screen';
import { screen as modulesPlanner } from '../hubs/[hub]/modules/planner/_screen';
import { screen as modulesMarketplace } from '../hubs/[hub]/modules/marketplace/_screen';
import { screen as modulesKnowledgeSharing } from '../hubs/[hub]/modules/knowledge-sharing/_screen';
import { screen as modulesEvents } from '../hubs/[hub]/modules/events/_screen';
import { screen as modulesLearning } from '../hubs/[hub]/modules/learning/_screen';
import { screen as modulesMatching } from '../hubs/[hub]/modules/matching/_screen';
import { screen as modulesCommerce } from '../hubs/[hub]/modules/commerce/_screen';
import { screen as agentsModules } from '../hubs/[hub]/agents/modules/_screen';
import { screen as agentsPolicy } from '../hubs/[hub]/agents/policy/_screen';
import { screen as agentsExtensions } from '../hubs/[hub]/agents/extensions/_screen';
import { screen as agentsExternal } from '../hubs/[hub]/agents/external/_screen';
import { screen as agentsUsage } from '../hubs/[hub]/agents/usage/_screen';
import { screen as agentsAbuse } from '../hubs/[hub]/agents/abuse/_screen';
import { screen as billingOffers } from '../hubs/[hub]/billing/offers/_screen';
import { screen as billingPrices } from '../hubs/[hub]/billing/prices/_screen';
import { screen as billingInvoices } from '../hubs/[hub]/billing/invoices/_screen';
import { screen as billingPayouts } from '../hubs/[hub]/billing/payouts/_screen';
import { screen as billingCredits } from '../hubs/[hub]/billing/credits/_screen';
import { screen as billingTax } from '../hubs/[hub]/billing/tax/_screen';
import { screen as communicationsSenders } from '../hubs/[hub]/communications/senders/_screen';
import { screen as communicationsTemplates } from '../hubs/[hub]/communications/templates/_screen';
import { screen as communicationsDeliverability } from '../hubs/[hub]/communications/deliverability/_screen';
import { screen as communicationsAnnouncements } from '../hubs/[hub]/communications/announcements/_screen';

/** Every built hub console screen; sections with status `demo` in their group file must have one here (tested). */
export const SCREENS: readonly Screen[] = [
  overview, approvals, help, identity, modes, modules, legal, residency, country, taxonomy, launch,
  // HUBC-004
  people, companies, claims, verification, credentials, consents, supportLookup, supportCases, supportRecovery, supportExplain,
  moderation, disputes, reputation, appeals, screening, confirmations,
  // HUBC-005
  modulesProjects, modulesPlanner, modulesMarketplace, modulesKnowledgeSharing, modulesEvents, modulesLearning, modulesMatching, modulesCommerce, agentsModules, agentsPolicy, agentsExtensions, agentsExternal, agentsUsage, agentsAbuse, billingOffers, billingPrices, billingInvoices, billingPayouts, billingCredits, billingTax, communicationsSenders, communicationsTemplates, communicationsDeliverability, communicationsAnnouncements,
];

export function screenFor(groupId: string, sectionId: string): Screen | null {
  return SCREENS.find((s) => s.group === groupId && s.id === sectionId) ?? null;
}
