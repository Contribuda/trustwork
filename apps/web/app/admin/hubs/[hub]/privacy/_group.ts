import type { GroupDef } from '../../../_data/section-types.js';

/** Console navigation group `privacy` (designed; built by HUBC-006, which flips `status` here). */
export const GROUP: GroupDef = {
  id: 'privacy',
  sections: [
    { id: 'requests', path: 'privacy/requests', read: ['admin.privacy.request.read'], status: 'designed', screen: 'HC-140' },
    { id: 'retention', path: 'privacy/retention', read: ['admin.privacy.request.read'], status: 'designed', screen: 'HC-141' },
    { id: 'settings', path: 'privacy/settings', read: ['admin.privacy.request.read'], status: 'designed', screen: 'HC-142' },
    { id: 'breaches', path: 'privacy/breaches', read: ['admin.privacy.request.read'], status: 'designed', screen: 'HC-143' },
  ],
};
