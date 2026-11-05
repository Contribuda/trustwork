import type { GroupDef } from '../../../_data/section-types.js';

/** Console navigation group `integrations` (designed on fixtures, HUBC-002; `live` marks what already runs on the API, HUBC-007). */
export const GROUP: GroupDef = {
  id: 'integrations',
  sections: [
    { id: 'providers', path: 'integrations/providers', read: ['admin.providers.read'], status: 'designed', live: true, screen: 'HC-100' },
    { id: 'routing', path: 'integrations/routing', read: ['admin.providers.read'], status: 'designed', screen: 'HC-101' },
    { id: 'egress', path: 'integrations/egress', read: ['admin.providers.read'], status: 'designed', live: true, screen: 'HC-102' },
    { id: 'budgets', path: 'integrations/budgets', read: ['admin.providers.read'], status: 'designed', screen: 'HC-103' },
    { id: 'usage', path: 'integrations/usage', read: ['admin.usage.read'], status: 'designed', screen: 'HC-104' },
    { id: 'killSwitches', path: 'integrations/kill-switches', read: ['admin.providers.read'], status: 'designed', screen: 'HC-105' },
  ],
};
