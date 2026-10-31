import type { GroupDef } from '../../../_data/section-types.js';

/** Console navigation group `hub` (built on synthetic fixtures by ADM-002). */
export const GROUP: GroupDef = {
  id: 'hub',
  sections: [
    { id: 'identity', path: 'hub/identity', read: ['admin.hub.read'], status: 'demo', screen: 'HC-10' },
    { id: 'modes', path: 'hub/modes', read: ['admin.hub.read'], status: 'demo', screen: 'HC-11' },
    { id: 'modules', path: 'hub/modules', read: ['admin.hub.read'], status: 'demo', screen: 'HC-12' },
    { id: 'legal', path: 'hub/legal', read: ['admin.hub.read'], status: 'demo', screen: 'HC-13' },
    { id: 'residency', path: 'hub/residency', read: ['admin.hub.read'], status: 'demo', screen: 'HC-14' },
    { id: 'country', path: 'hub/country', read: ['admin.hub.read'], status: 'demo', screen: 'HC-15' },
    { id: 'taxonomy', path: 'hub/taxonomy', read: ['admin.taxonomy.read'], status: 'demo', screen: 'HC-16' },
    { id: 'launch', path: 'hub/launch', read: ['admin.hub.read'], status: 'demo', screen: 'HC-17' },
  ],
};
