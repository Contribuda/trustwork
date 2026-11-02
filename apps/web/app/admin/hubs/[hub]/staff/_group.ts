import type { GroupDef } from '../../../_data/section-types.js';

/** Console navigation group `staff`: HC-150 Staff is built (fixtures and the live API); HC-153 Audit is designed (HUBC-006). */
export const GROUP: GroupDef = {
  id: 'staff',
  sections: [
    { id: 'staff', path: 'staff', read: ['admin.staff.read'], status: 'demo', screen: 'HC-150' },
    { id: 'audit', path: 'audit', read: ['admin.audit.read'], status: 'designed', screen: 'HC-153' },
  ],
};
