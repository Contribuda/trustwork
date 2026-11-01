import type { GroupDef } from '../../../_data/section-types.js';

/** Console navigation group `agents` (built on synthetic fixtures by HUBC-005). */
export const GROUP: GroupDef = {
  id: 'agents',
  sections: [
    { id: 'modules', path: 'agents/modules', read: ['admin.agents.read'], status: 'demo', screen: 'HC-80' },
    { id: 'policy', path: 'agents/policy', read: ['admin.agents.read'], status: 'demo', screen: 'HC-81' },
    { id: 'extensions', path: 'agents/extensions', read: ['admin.agents.read'], status: 'demo', screen: 'HC-85' },
    { id: 'external', path: 'agents/external', read: ['admin.agents.read'], status: 'demo', screen: 'HC-82' },
    { id: 'usage', path: 'agents/usage', read: ['admin.agents.read'], status: 'demo', screen: 'HC-83' },
    { id: 'abuse', path: 'agents/abuse', read: ['admin.agents.read'], status: 'demo', screen: 'HC-84' },
  ],
};
