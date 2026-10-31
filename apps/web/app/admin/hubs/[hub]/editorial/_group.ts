import type { GroupDef } from '../../../_data/section-types.js';

/** Console navigation group `editorial` (designed; built by HUBC-003, which flips `status` here). */
export const GROUP: GroupDef = {
  id: 'editorial',
  sections: [
    { id: 'desk', path: 'editorial', read: ['admin.publications.read'], status: 'designed', screen: 'HC-40' },
    { id: 'sources', path: 'editorial/sources', read: ['admin.sources.read'], status: 'designed', screen: 'HC-41' },
    { id: 'discovery', path: 'editorial/discovery', read: ['admin.sources.read'], status: 'designed', screen: 'HC-42' },
    { id: 'pipelines', path: 'editorial/pipelines', read: ['admin.pipelines.read'], status: 'designed', screen: 'HC-43' },
    { id: 'review', path: 'editorial/review', read: ['admin.publications.read'], status: 'designed', screen: 'HC-44' },
    { id: 'calendar', path: 'editorial/calendar', read: ['admin.publications.read'], status: 'designed', screen: 'HC-45' },
    { id: 'publications', path: 'editorial/publications', read: ['admin.publications.read'], status: 'designed', screen: 'HC-46' },
    { id: 'magazine', path: 'editorial/magazine', read: ['admin.issues.read'], status: 'designed', screen: 'HC-47' },
    { id: 'translations', path: 'editorial/translations', read: ['admin.publications.read'], status: 'designed', screen: 'HC-48' },
    { id: 'policy', path: 'editorial/policy', read: ['admin.pipelines.read'], status: 'designed', screen: 'HC-49' },
  ],
};
