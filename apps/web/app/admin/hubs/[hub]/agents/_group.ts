import type { GroupDef } from '../../../_data/section-types.js';

/** Console navigation group `agents` (designed; built by HUBC-005, which flips `status` here). */
export const GROUP: GroupDef = {
  id: 'agents',
  sections: [
    { id: 'modules', path: 'agents/modules', read: ['admin.agents.read'], status: 'designed', screen: 'HC-80' },
    { id: 'policy', path: 'agents/policy', read: ['admin.agents.read'], status: 'designed', screen: 'HC-81' },
    { id: 'extensions', path: 'agents/extensions', read: ['admin.agents.read'], status: 'designed', screen: 'HC-85' },
    { id: 'external', path: 'agents/external', read: ['admin.agents.read'], status: 'designed', screen: 'HC-82' },
    { id: 'usage', path: 'agents/usage', read: ['admin.agents.read'], status: 'designed', screen: 'HC-83' },
    { id: 'abuse', path: 'agents/abuse', read: ['admin.agents.read'], status: 'designed', screen: 'HC-84' },
  ],
};
