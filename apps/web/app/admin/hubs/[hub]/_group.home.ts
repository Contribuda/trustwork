import type { GroupDef } from '../../_data/section-types.js';

/** Console navigation group `home` (built on synthetic fixtures by ADM-002). */
export const GROUP: GroupDef = {
  id: 'home',
  sections: [
    { id: 'overview', path: '', read: 'staff', status: 'demo', screen: 'HC-01' },
    { id: 'approvals', path: 'approvals', read: 'staff', status: 'demo', screen: 'HC-02' },
    { id: 'help', path: 'help', read: 'staff', status: 'demo', screen: 'HC-03' },
  ],
};
