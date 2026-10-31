import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { artwork, artworkFor, coverFor, hashSeed, listArtworks, listPhotos, photo, registerPhotos, type MediaKind } from '../../src/media/index';

const here = dirname(fileURLToPath(import.meta.url));
const media = join(here, '../../media');

test('the engine media set is 16 artworks on disk and no photographs', () => {
  const artworks = listArtworks();
  assert.equal(artworks.length, 16);
  assert.deepEqual(listPhotos(), []);
  for (const item of artworks) assert.ok(existsSync(join(media, 'artworks', `${item.id}.svg`)), `${item.id}.svg missing`);
  assert.equal(existsSync(join(media, 'photos')), false, 'no photographs ship with the engine');
  assert.throws(() => photo('anything'), /no photographs/);
  assert.equal(artworkFor('former-photo-id').type, 'artwork');
});

test('a deployment can register its own photographs and coverFor mixes them in', () => {
  registerPhotos([{ type: 'photo', id: 'own-1', alt: 'own', width: 1600, height: 1000, aspect: 1.6, placeholder: '', src: '/media/photos/own-1.webp', srcSet: '', tone: 'light', kinds: ['facade'], author: 'operator', license: 'operator' }]);
  assert.equal(listPhotos().length, 1);
  assert.equal(photo('own-1').id, 'own-1');
  registerPhotos([]);
  assert.deepEqual(listPhotos(), []);
});


test('coverFor is deterministic, spreads across the artwork pool and never gives people a photograph', () => {
  const kinds: MediaKind[] = ['article', 'news', 'company', 'person', 'project', 'material', 'site', 'facade', 'structure', 'drawing', 'supply', 'magazine', 'any'];
  for (const kind of kinds) {
    const a = coverFor(kind, 'seed-1');
    const b = coverFor(kind, 'seed-1');
    assert.deepEqual(a, b, `${kind} not deterministic`);
    assert.equal(a.type, 'artwork', `${kind}: the engine has no photographs to pick`);
    const ids = new Set(Array.from({ length: 40 }, (_, i) => coverFor(kind, i).id));
    // `drawing` has a deliberately small artwork pool (one piece); every other kind spreads over several.
    assert.ok(ids.size >= (kind === 'drawing' ? 1 : 3), `${kind} only used ${ids.size} distinct covers over 40 seeds`);
  }
  for (let i = 0; i < 60; i++) assert.equal(coverFor('person', i).type, 'artwork');
  registerPhotos([{ type: 'photo', id: 'own-facade', alt: 'own', width: 1600, height: 1000, aspect: 1.6, placeholder: '', src: '/media/photos/own-facade.webp', srcSet: '', tone: 'light', kinds: ['facade', 'company'], author: 'operator', license: 'operator' }]);
  assert.equal(coverFor('company', 'x', { prefer: 'photo' }).type, 'photo');
  assert.equal(coverFor('company', 'x', { prefer: 'artwork' }).type, 'artwork');
  for (let i = 0; i < 60; i++) assert.equal(coverFor('person', i).type, 'artwork', 'people never receive photographs even when some are registered');
  registerPhotos([]);
});

test('hashSeed is stable and references resolve', () => {
  assert.equal(hashSeed('company:x'), hashSeed('company:x'));
  assert.notEqual(hashSeed('company:x'), hashSeed('company:y'));
  assert.equal(artwork('blueprint-lines').tone, 'dark');
  assert.equal(artworkFor('cranes-sky').type, 'artwork');
  assert.equal(artworkFor('cranes-sky').id, artworkFor('cranes-sky').id);
  assert.throws(() => artwork('missing'));
  assert.throws(() => photo('missing'));
});
