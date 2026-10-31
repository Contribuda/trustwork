import { messageOrUndefined } from '../i18n';
import artworkManifest from '../../media/artworks/manifest.json';

/**
 * Media set of @trustwork/ui: 16 generated SVG artworks (media/artworks, original, no third-party rights).
 * `coverFor(kind, seed)` assigns one deterministically so fixtures and lists look rich without manual picking.
 * The engine ships no photographs (owner decision 2026-10-29: the earlier third-party photo set is not open-licensed and
 * showed real faces on synthetic profiles); a deployment adds its own licensed photographs through `PhotoRef`
 * values it constructs itself. Files are served from `mediaBase` (default `/media`).
 */

export type MediaKind = 'article' | 'news' | 'company' | 'person' | 'project' | 'material' | 'site' | 'facade' | 'structure' | 'drawing' | 'supply' | 'magazine' | 'any';

export type PhotoRef = {
  type: 'photo';
  id: string;
  alt: string;
  width: number;
  height: number;
  aspect: number;
  /** Tiny WebP data URI for the blur-up placeholder. */
  placeholder: string;
  src: string;
  srcSet: string;
  tone: 'light' | 'dark';
  kinds: readonly string[];
  author: string;
  license: string;
};

export type ArtworkRef = {
  type: 'artwork';
  id: string;
  alt: string;
  src: string;
  /** `dark` artworks can carry light text without a scrim. */
  tone: 'light' | 'dark';
  dominant: string;
  kinds: readonly string[];
};

export type MediaRef = PhotoRef | ArtworkRef;

let mediaBase = '/media';

/** Sets the URL prefix under which `packages/ui/media` is served (no trailing slash). */
export function configureMedia(options: { base: string }): void {
  mediaBase = options.base.replace(/\/$/, '');
}

export function getMediaBase(): string {
  return mediaBase;
}

type ArtworkEntry = (typeof artworkManifest)['artworks'][number];

function artworkRef(entry: ArtworkEntry): ArtworkRef {
  return {
    type: 'artwork',
    id: entry.id,
    alt: messageOrUndefined(`media.artworks.${entry.id}`) ?? entry.alt,
    src: `${mediaBase}/artworks/${entry.file}`,
    tone: entry.tone as 'light' | 'dark',
    dominant: entry.dominant,
    kinds: entry.kinds,
  };
}

/** Photographs registered by the deployment (the engine ships none). */
const registeredPhotos: PhotoRef[] = [];

/** A deployment registers its own licensed photographs; `coverFor()` then mixes them in deterministically. */
export function registerPhotos(photos: PhotoRef[]): void {
  registeredPhotos.splice(0, registeredPhotos.length, ...photos);
}

/** All photographs, in registration order (stable); empty in the engine. */
export function listPhotos(): PhotoRef[] {
  return [...registeredPhotos];
}

/** All artworks, in manifest order (stable). */
export function listArtworks(): ArtworkRef[] {
  return artworkManifest.artworks.map(artworkRef);
}

export function photo(id: string): PhotoRef {
  const entry = registeredPhotos.find((p) => p.id === id);
  if (!entry) throw new Error(`Unknown photo "${id}" (the engine ships no photographs; register them with registerPhotos())`);
  return entry;
}

/** Deterministic artwork for a seed (a former photograph id, a slug): the engine's answer wherever a deployment may plug a photo. */
export function artworkFor(seed: string, kind: MediaKind = 'any'): ArtworkRef {
  return coverFor(kind, seed, { prefer: 'artwork' }) as ArtworkRef;
}

export function artwork(id: string): ArtworkRef {
  const entry = artworkManifest.artworks.find((a) => a.id === id);
  if (!entry) throw new Error(`Unknown artwork "${id}"`);
  return artworkRef(entry);
}

/** FNV-1a 32-bit hash: deterministic across runtimes, good spread for short strings. */
export function hashSeed(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Which manifest `kinds` tags satisfy each media kind. `person` never gets a cover photograph; consented portraits are referenced by id from profiles, not picked by coverFor(). */
const kindTags: Record<Exclude<MediaKind, 'any'>, readonly string[]> = {
  article: ['article', 'material', 'drawing', 'texture', 'structure'],
  news: ['news', 'site', 'facade', 'equipment', 'aerial'],
  company: ['company', 'facade', 'supply'],
  person: ['texture', 'material', 'drawing'],
  project: ['project', 'site', 'facade', 'structure', 'aerial'],
  material: ['material', 'texture', 'supply'],
  site: ['site', 'aerial', 'equipment'],
  facade: ['facade', 'glass'],
  structure: ['structure', 'steel', 'wood'],
  drawing: ['drawing', 'document'],
  supply: ['supply', 'material', 'equipment'],
  magazine: ['facade', 'material', 'structure', 'site'],
};

export type CoverOptions = {
  /** `photo` or `artwork` forces a pool; `any` (default) mixes them deterministically (60 % photographs). */
  prefer?: 'photo' | 'artwork' | 'any' | undefined;
};

/**
 * Deterministically assigns a cover to an entity: same `kind` + `seed` always yields the same media,
 * neighbouring seeds spread across the pool. `person` resolves to artworks only (no portraits, no
 * synthetic people).
 */
export function coverFor(kind: MediaKind, seed: string | number, options: CoverOptions = {}): MediaRef {
  const prefer = kind === 'person' ? 'artwork' : (options.prefer ?? 'any');
  const h = hashSeed(`${kind}:${String(seed)}`);
  const tags = kind === 'any' ? null : kindTags[kind];
  const filter = <T extends { kinds: readonly string[] }>(items: T[]): T[] => {
    if (!tags) return items;
    const matching = items.filter((item) => item.kinds.some((k) => tags.includes(k)));
    return matching.length ? matching : items;
  };
  const photos = prefer === 'artwork' ? [] : filter(listPhotos());
  const artworks = prefer === 'photo' ? [] : filter(listArtworks());
  const usePhoto = prefer === 'photo' || (prefer === 'any' && photos.length > 0 && h % 10 < 6);
  const pool: MediaRef[] = usePhoto && photos.length ? photos : artworks.length ? artworks : photos;
  if (!pool.length) throw new Error('media manifests are empty');
  const pick = pool[Math.floor(h / 10) % pool.length];
  if (!pick) throw new Error('media selection failed');
  return pick;
}

/** `sizes` attribute helper for the three published widths. */
export const coverSizes = {
  full: '(max-width: 767px) 100vw, 1200px',
  half: '(max-width: 767px) 100vw, 600px',
  third: '(max-width: 767px) 100vw, 400px',
  thumb: '(max-width: 767px) 50vw, 240px',
} as const;
