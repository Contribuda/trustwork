import type { GroupDef } from '../../../_data/section-types.js';

/**
 * Console navigation group `outreach` (OUTR-004, HC-170 to HC-177, on synthetic fixtures). Reads use the existing
 * console vocabulary until OUTR-002 proposes dedicated outreach permissions: communications staff read the section,
 * jurisdiction editors and the compliance officer who requests a version's activation also read the policies, and only privacy staff look up a suppression.
 */
export const GROUP: GroupDef = {
  id: 'outreach',
  sections: [
    { id: 'overview', path: 'outreach', read: ['admin.notifications.read'], status: 'demo', screen: 'HC-170' },
    { id: 'policies', path: 'outreach/policies', read: ['admin.notifications.read', 'admin.hub.jurisdiction.edit', 'admin.hub.jurisdiction.activate'], status: 'demo', screen: 'HC-171' },
    { id: 'campaigns', path: 'outreach/campaigns', read: ['admin.notifications.read'], status: 'demo', screen: 'HC-172' },
    { id: 'templates', path: 'outreach/templates', read: ['admin.notifications.read'], status: 'demo', screen: 'HC-173' },
    { id: 'replies', path: 'outreach/replies', read: ['admin.notifications.read'], status: 'demo', screen: 'HC-174' },
    { id: 'suppression', path: 'outreach/suppression', read: ['admin.privacy.request.read'], status: 'demo', screen: 'HC-175' },
    { id: 'deliverability', path: 'outreach/deliverability', read: ['admin.notifications.read'], status: 'demo', screen: 'HC-176' },
    { id: 'lifecycle', path: 'outreach/lifecycle', read: ['admin.notifications.read'], status: 'demo', screen: 'HC-177' },
  ],
};
