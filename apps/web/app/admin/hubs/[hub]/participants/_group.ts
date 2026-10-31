import type { GroupDef } from '../../../_data/section-types.js';

/** Console navigation group `participants` (designed; built by HUBC-004, which flips `status` here). */
export const GROUP: GroupDef = {
  id: 'participants',
  sections: [
    { id: 'people', path: 'participants/people', read: ['admin.people.consent.read', 'admin.claims.read'], status: 'designed', screen: 'HC-20' },
    { id: 'companies', path: 'participants/companies', read: ['admin.claims.read'], status: 'designed', screen: 'HC-21' },
    { id: 'claims', path: 'participants/claims', read: ['admin.claims.read'], status: 'designed', screen: 'HC-22' },
    { id: 'verification', path: 'participants/verification', read: ['admin.claims.read'], status: 'designed', screen: 'HC-23' },
    { id: 'credentials', path: 'participants/credentials', read: ['admin.claims.read'], status: 'designed', screen: 'HC-24' },
    { id: 'consents', path: 'participants/consents', read: ['admin.people.consent.read'], status: 'designed', screen: 'HC-25' },
  ],
};
