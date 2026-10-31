import type { GroupDef } from '../../../_data/section-types.js';

/** Console navigation group `ops` (designed; built by HUBC-006, which flips `status` here). */
export const GROUP: GroupDef = {
  id: 'ops',
  sections: [
    { id: 'health', path: 'ops/health', read: ['admin.observability.read'], status: 'designed', screen: 'HC-160' },
    { id: 'jobs', path: 'ops/jobs', read: ['admin.observability.read'], status: 'designed', screen: 'HC-161' },
    { id: 'flags', path: 'ops/flags', read: ['admin.observability.read'], status: 'designed', screen: 'HC-162' },
    { id: 'maintenance', path: 'ops/maintenance', read: ['admin.observability.read'], status: 'designed', screen: 'HC-163' },
    { id: 'incidents', path: 'ops/incidents', read: ['admin.observability.read'], status: 'designed', screen: 'HC-164' },
    { id: 'locales', path: 'ops/locales', read: ['admin.ops.locales.read'], status: 'designed', screen: 'HC-165' },
    { id: 'accessibility', path: 'ops/accessibility', read: ['admin.observability.read'], status: 'designed', screen: 'HC-166' },
  ],
};
