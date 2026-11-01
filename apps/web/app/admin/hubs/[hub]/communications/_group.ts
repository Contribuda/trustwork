import type { GroupDef } from '../../../_data/section-types.js';

/** Console navigation group `communications` (built on synthetic fixtures by HUBC-005). */
export const GROUP: GroupDef = {
  id: 'communications',
  sections: [
    { id: 'senders', path: 'communications/senders', read: ['admin.notifications.read'], status: 'demo', screen: 'HC-120' },
    { id: 'templates', path: 'communications/templates', read: ['admin.notifications.read'], status: 'demo', screen: 'HC-121' },
    { id: 'deliverability', path: 'communications/deliverability', read: ['admin.notifications.read'], status: 'demo', screen: 'HC-122' },
    { id: 'announcements', path: 'communications/announcements', read: ['admin.notifications.read'], status: 'demo', screen: 'HC-123' },
  ],
};
