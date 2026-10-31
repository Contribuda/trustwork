import { artwork, artworkFor, configureMedia, coverFor, coverSizes, type MediaKind, type MediaRef } from '@trustwork/ui/media';
import { BASE_PATH } from './base-path';

configureMedia({ base: `${BASE_PATH}/media` });
import type { PublicationCard } from './data';

/**
 * Cover assignment for apps/web view models. `coverFor(kind, seed)` is deterministic (FNV-1a over
 * kind + seed), so the same story, company, person, project or issue always shows the same artwork
 * across renders and deployments (the engine ships no photographs). Editorial picks for the lead stories and the magazine
 * are pinned here so the home page and the issue pages stay composed rather than random.
 *
 * Rules (docs/design/system/media.md): people never receive photographs (artwork + initials), nothing
 * here depicts a real person, company or brand, and `alt` always comes from the manifests.
 */

const PINNED: Record<string, string> = {
  'rynok-fasadnyh-sistem-itogi-kvartala': 'glass-grid',
  'novye-trebovaniya-k-pozharnym-ispytaniyam': 'corrugated-sheet',
  'vystavka-stroitelnyh-tehnologij-moskva': 'iso-blocks',
  'proizvoditel-podsistem-rasshiril-sklad': 'brick-bond',
  'issledovanie-vlazhnosti-utepliteley': 'terrazzo',
  'gorod-utverdil-programmu-obnovleniya-fasadov': 'facade-cassettes',
  'konkurs-molodyh-inzhenerov': 'blueprint-lines',
  'postavshchik-stekla-zapustil-liniyu': 'glass-night',
  'fasad-za-sezon-kak-planirovat-montazh': 'timber-frame',
  'logistika-sbornyh-konstrukcij': 'formwork',
  'cifrovoj-pasport-izdeliya': 'blueprint-lines',
  'trebovaniya-k-ispytaniyam-uteplitelya': 'mineral-wool',
  'material-pod-zadachu-kak-sdelat-vybor': 'concrete-grain',
  'chto-stoit-za-srokom-postavki': 'rebar-mesh',
  'proizvodstvo-iznutri-ot-syrya-do-izdeliya': 'steel-profile',
  'kogda-tekhnologiya-dejstvitelno-pomogaet': 'blueprint-lines',
  'slovar-materialov': 'wall-layers',
  'voprosy-postavshchiku': 'blueprint-lines',
  'podgotovka-k-vstreche': 'iso-blocks',
  'rabota-v-kotoroj-vazhny-detali': 'wood-lamellae',
  'masterstvo-kotoroe-peredayut-dalshe': 'steel-profile',
  'kak-skladyvaetsya-obshchij-rezultat': 'timber-frame',
  'kak-sravnivat-predlozheniya-fasad': 'facade-cassettes',
  'priemka-fasada-po-etapam': 'wall-layers',
  'intervyu-tehnolog-o-protokolah': 'mineral-wool',
  'cheklist-zaprosa-postavshchiku': 'blueprint-lines',
  'obzor-rynka-minvaty': 'concrete-grain',
  'standart-ventfasady-vesna': 'glass-grid',
  'itogi-konferencii-bim': 'blueprint-lines',
  'zavod-tatarstan-minvata': 'corrugated-sheet',
  'issledovanie-klinker': 'brick-bond',
};

const ISSUE_COVERS: Record<number, string> = {
  12: 'glass-grid',
  11: 'terrazzo',
  10: 'steel-profile',
  9: 'blueprint-lines',
};

function resolvePick(pick: string): MediaRef {
  return artwork(pick);
}

/** Media for a fixture reference (a former photograph id): a deterministic artwork until a deployment registers photographs. */
export function fixtureMedia(ref: string, kind: MediaKind = 'any'): MediaRef {
  return artworkFor(ref, kind);
}

export function storyCover(card: Pick<PublicationCard, 'id' | 'slug' | 'format'>): MediaRef {
  const pick = PINNED[card.slug];
  return pick ? resolvePick(pick) : coverFor(card.format === 'news' ? 'news' : 'article', card.slug || card.id);
}

export function entityCover(kind: 'company' | 'person' | 'project', seed: string): MediaRef {
  return coverFor(kind, seed);
}

export function issueCover(number: number): MediaRef {
  const pick = ISSUE_COVERS[number];
  return pick ? resolvePick(pick) : coverFor('magazine', `issue-${number}`);
}

export function cover(kind: MediaKind, seed: string): MediaRef {
  return coverFor(kind, seed);
}

export { artwork, coverSizes, artworkFor };
export type { MediaRef };

/** Event cover from a fixture reference («photo:id» resolves to a deterministic artwork, «artwork:id» directly); unknown references fall back to a deterministic news cover. */
export function eventCover(ref: string): MediaRef {
  const [kind, id] = ref.split(':');
  if (kind === 'photo' && id) return artworkFor(id, 'news');
  if (kind === 'artwork' && id) return artwork(id);
  return coverFor('news', ref);
}

const PROJECT_PHOTOS: Record<string, string> = {
  'shkola-na-reke': 'facade-window-grid',
  'sklad-logistika': 'corrugated-building',
  'dacha-petra': 'timber-framing',
  'park-u-zavoda': 'glass-steel-facade',
};

/** Project cover: a pinned photograph for known fixtures, otherwise the deterministic project artwork. */
export function projectCover(slug: string): MediaRef {
  const pick = PROJECT_PHOTOS[slug];
  return pick ? artworkFor(pick, 'project') : coverFor('project', slug);
}

const KIND_PHOTOS: Record<string, string[]> = {
  developer: ['highrise-windows', 'aerial-site-foundations', 'crane-tower', 'facade-window-grid'],
  client: ['office-laptop-work', 'site-women-blueprints', 'blueprints-spread', 'aerial-site-excavator'],
  generalContractor: ['cranes-sky', 'aerial-site-foundations', 'house-scaffolding', 'site-wall-measuring'],
  logistics: ['crane-tower', 'bricks-pallet', 'aerial-site-fields', 'rebar-bundle'],
  manufacturer: ['workshop-metal-frame', 'bricks-pallet', 'rebar-bundle', 'roof-tiles-clay'],
  supplier: ['wood-planks', 'stacked-brick', 'bricks-pallet', 'rebar-bundle'],
  contractor: ['scaffolding-poles', 'house-scaffolding', 'site-wall-measuring', 'crane-tower'],
  designer: ['blueprints-spread', 'technical-drawing', 'site-women-blueprints', 'office-laptop-work'],
  equipment: ['workshop-metal-frame', 'steel-roof-beams', 'corrugated-building', 'cranes-sky'],
  services: ['office-laptop-work', 'technical-drawing', 'concrete-wall', 'site-women-blueprints'],
};

/** Three illustrative photographs for a company row by its activity profile (stock, not the company's own). */
export function companyPhotos(kinds: readonly string[], seed: string): MediaRef[] {
  const pool = [...new Set(kinds.flatMap((k) => KIND_PHOTOS[k] ?? []))];
  if (!pool.length) return [coverFor('company', `${seed}-0`), coverFor('company', `${seed}-1`), coverFor('company', `${seed}-2`)];
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return [0, 1, 2].map((i) => artworkFor(pool[(h + i) % pool.length]!, 'project'));
}

