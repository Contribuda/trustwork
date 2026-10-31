import type { GroupDef } from '../../../_data/section-types.js';

/** Console navigation group `trust` (designed; built by HUBC-004, which flips `status` here). */
export const GROUP: GroupDef = {
  id: 'trust',
  sections: [
    { id: 'moderation', path: 'trust/moderation', read: ['admin.moderation.read'], status: 'designed', screen: 'HC-70' },
    { id: 'disputes', path: 'trust/disputes', read: ['admin.trust.evidence.decide'], status: 'designed', screen: 'HC-71' },
    { id: 'reputation', path: 'trust/reputation', read: ['admin.trust.evidence.decide', 'admin.trust.method.release'], status: 'designed', screen: 'HC-72' },
    { id: 'appeals', path: 'trust/appeals', read: ['admin.trust.evidence.decide', 'admin.trust.appeals.decide'], status: 'designed', screen: 'HC-73' },
    { id: 'screening', path: 'trust/screening', read: ['admin.claims.read'], status: 'designed', screen: 'HC-74' },
    { id: 'confirmations', path: 'trust/confirmations', read: ['admin.claims.read'], status: 'designed', screen: 'HC-75' },
  ],
};
