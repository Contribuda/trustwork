import type { GroupDef } from '../../../_data/section-types.js';

/** Console navigation group `federation` (designed; built by HUBC-006, which flips `status` here). */
export const GROUP: GroupDef = {
  id: 'federation',
  sections: [
    { id: 'peers', path: 'federation/peers', read: ['admin.federation.read'], status: 'designed', screen: 'HC-130' },
    { id: 'licences', path: 'federation/licences', read: ['admin.federation.read'], status: 'designed', screen: 'HC-131' },
    { id: 'tombstones', path: 'federation/tombstones', read: ['admin.federation.read'], status: 'designed', screen: 'HC-132' },
    { id: 'links', path: 'federation/links', read: ['admin.federation.read'], status: 'designed', screen: 'HC-133' },
  ],
};
