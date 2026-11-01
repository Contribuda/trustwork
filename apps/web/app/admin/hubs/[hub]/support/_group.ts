import type { GroupDef } from '../../../_data/section-types.js';

/** Console navigation group `support` (built on synthetic fixtures by HUBC-004; HUBC-009 wires the live backends). */
export const GROUP: GroupDef = {
  id: 'support',
  sections: [
    { id: 'lookup', path: 'support', read: ['admin.support.account.read'], status: 'demo', screen: 'HC-30' },
    { id: 'cases', path: 'support/cases', read: ['admin.support.account.read'], status: 'demo', screen: 'HC-33' },
    { id: 'recovery', path: 'support/recovery', read: ['admin.support.account.read'], status: 'demo', screen: 'HC-34' },
    { id: 'explain', path: 'support/explain', read: ['admin.support.account.read'], status: 'demo', screen: 'HC-35' },
  ],
};
