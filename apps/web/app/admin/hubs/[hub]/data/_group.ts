import type { GroupDef } from '../../../_data/section-types.js';

/** Console navigation group `data` (designed; built by HUBC-003, which flips `status` here). */
export const GROUP: GroupDef = {
  id: 'data',
  sections: [
    { id: 'datasets', path: 'data/datasets', read: ['admin.datasets.read'], status: 'designed', screen: 'HC-50' },
    { id: 'batches', path: 'data/batches', read: ['admin.sources.read'], status: 'designed', screen: 'HC-51' },
    { id: 'links', path: 'data/links', read: ['admin.datasets.read', 'admin.sources.read'], status: 'designed', screen: 'HC-52' },
    { id: 'knowledge', path: 'data/knowledge', read: ['admin.retrieval.read'], status: 'designed', screen: 'HC-53' },
    { id: 'recommendations', path: 'data/recommendations', read: ['admin.hub.read'], status: 'designed', screen: 'HC-54' },
  ],
};
