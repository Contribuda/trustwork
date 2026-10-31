import type { GroupDef } from '../../../_data/section-types.js';

/** Console navigation group `automation` (designed; built by HUBC-002, which flips `status` here). */
export const GROUP: GroupDef = {
  id: 'automation',
  sections: [
    { id: 'schedules', path: 'automation/schedules', read: ['admin.pipelines.read'], status: 'designed', screen: 'HC-110' },
    { id: 'runs', path: 'automation/runs', read: ['admin.pipelines.read'], status: 'designed', screen: 'HC-111' },
    { id: 'alerts', path: 'automation/alerts', read: ['admin.pipelines.read'], status: 'designed', screen: 'HC-112' },
  ],
};
