import type { GroupDef } from '../../../_data/section-types.js';

/** Console navigation group `trust` (built on synthetic fixtures by HUBC-004; HUBC-009 wires the live backends). */
export const GROUP: GroupDef = {
  id: 'trust',
  sections: [
    { id: 'moderation', path: 'trust/moderation', read: ['admin.moderation.read'], status: 'demo', screen: 'HC-70' },
    { id: 'disputes', path: 'trust/disputes', read: ['admin.trust.evidence.decide'], status: 'demo', screen: 'HC-71' },
    { id: 'reputation', path: 'trust/reputation', read: ['admin.trust.evidence.decide', 'admin.trust.method.release'], status: 'demo', screen: 'HC-72' },
    { id: 'appeals', path: 'trust/appeals', read: ['admin.trust.evidence.decide', 'admin.trust.appeals.decide'], status: 'demo', screen: 'HC-73' },
    { id: 'screening', path: 'trust/screening', read: ['admin.claims.read'], status: 'demo', screen: 'HC-74' },
    { id: 'confirmations', path: 'trust/confirmations', read: ['admin.claims.read'], status: 'demo', screen: 'HC-75' },
  ],
};
