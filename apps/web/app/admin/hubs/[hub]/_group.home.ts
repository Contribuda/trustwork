import type { GroupDef } from '../../_data/section-types.js';

/** Console navigation group `home` (built on synthetic fixtures by ADM-002). */
export const GROUP: GroupDef = {
  id: 'home',
  sections: [
    { id: 'overview', path: '', read: 'staff', status: 'demo', screen: 'HC-01' },
    { id: 'approvals', path: 'approvals', read: 'staff', status: 'demo', screen: 'HC-02' },
    { id: 'inbox', path: 'inbox', read: 'staff', status: 'demo', screen: 'HC-05', labelKey: 'consoleNav.inbox' },
    { id: 'users', path: 'users', read: 'staff', status: 'demo', screen: 'HC-20', labelKey: 'consoleNav.users' },
    { id: 'help', path: 'help', read: 'staff', status: 'demo', screen: 'HC-03' },
  ],
};
