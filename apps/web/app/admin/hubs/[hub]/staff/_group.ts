import type { GroupDef } from '../../../_data/section-types.js';

/** Console navigation group `staff` (designed; built by HUBC-006, which flips `status` here). */
export const GROUP: GroupDef = {
  id: 'staff',
  sections: [
    { id: 'staff', path: 'staff', read: ['admin.staff.read'], status: 'designed', screen: 'HC-150' },
    { id: 'audit', path: 'audit', read: ['admin.audit.read'], status: 'designed', screen: 'HC-153' },
  ],
};
