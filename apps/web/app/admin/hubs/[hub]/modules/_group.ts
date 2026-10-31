import type { GroupDef } from '../../../_data/section-types.js';

/** Console navigation group `modules` (designed; built by HUBC-005, which flips `status` here). */
export const GROUP: GroupDef = {
  id: 'modules',
  sections: [
    { id: 'projects', path: 'modules/projects', read: ['admin.commerce.flows.read'], status: 'designed', screen: 'HC-60' },
    { id: 'planner', path: 'modules/planner', read: ['admin.hub.read'], status: 'designed', screen: 'HC-61' },
    { id: 'marketplace', path: 'modules/marketplace', read: ['admin.hub.read'], status: 'designed', screen: 'HC-62' },
    { id: 'knowledgeSharing', path: 'modules/knowledge-sharing', read: ['admin.hub.read'], status: 'designed', screen: 'HC-63' },
    { id: 'events', path: 'modules/events', read: ['admin.events.read'], status: 'designed', screen: 'HC-64' },
    { id: 'learning', path: 'modules/learning', read: ['admin.learning.read'], status: 'designed', screen: 'HC-65' },
    { id: 'matching', path: 'modules/matching', read: ['admin.matching.read'], status: 'designed', screen: 'HC-66' },
    { id: 'commerce', path: 'modules/commerce', read: ['admin.commerce.flows.read'], status: 'designed', screen: 'HC-67' },
    { id: 'procurement', path: 'modules/procurement', read: ['admin.commerce.flows.read'], status: 'designed', screen: 'HC-68' },
  ],
};
