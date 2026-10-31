import { TaxonomyTreeSchema, type TaxonomyTree } from '../../../../_data/schemas.js';
import { HUB_US_ID } from '../../../../_fixtures/ids.js';

/** Section-local fixtures of HC-16: two small trees of the US demo hub (labels are data in the hub's languages). The Samarkand example has none yet. */
export const TAXONOMY: readonly TaxonomyTree[] = [
  TaxonomyTreeSchema.parse({
    synthetic: true,
    hubId: HUB_US_ID,
    kind: 'topics',
    version: 2,
    releasedAt: '2026-10-20T09:00:00Z',
    terms: [
      { key: 'materials', parent: null, label: { en: 'Materials', es: 'Materiales' }, usage: 14, deprecated: false },
      { key: 'materials.concrete', parent: 'materials', label: { en: 'Concrete', es: 'Concreto' }, usage: 6, deprecated: false },
      { key: 'materials.timber', parent: 'materials', label: { en: 'Mass timber', es: 'Madera masiva' }, usage: 3, deprecated: false },
      { key: 'regulation', parent: null, label: { en: 'Codes and permits', es: 'Códigos y permisos' }, usage: 9, deprecated: false },
      { key: 'regulation.title24', parent: 'regulation', label: { en: 'Energy code updates', es: 'Actualizaciones del código energético' }, usage: 2, deprecated: false },
      { key: 'markets', parent: null, label: { en: 'Markets', es: 'Mercados' }, usage: 0, deprecated: true },
    ],
  }),
  TaxonomyTreeSchema.parse({
    synthetic: true,
    hubId: HUB_US_ID,
    kind: 'plan_steps',
    version: 1,
    releasedAt: null,
    terms: [
      { key: 'design', parent: null, label: { en: 'Design and permits', es: 'Diseño y permisos' }, usage: 4, deprecated: false },
      { key: 'design.adu-permit', parent: 'design', label: { en: 'Accessory dwelling unit permit', es: 'Permiso de vivienda accesoria' }, usage: 2, deprecated: false },
      { key: 'build', parent: null, label: { en: 'Construction', es: 'Construcción' }, usage: 3, deprecated: false },
    ],
  }),
];
