import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { digitalSourceTypeUri } from '../../packages/contracts/src/provenance.js';
import { carryDigitalSourceType, ImageCarrierError, readDigitalSourceType, xmpPacket } from '../../apps/worker/src/provenance/xmp.js';
import { inspect, sha256Hex } from '../../apps/worker/src/files/inspect.js';

const TRAINED = 'trainedAlgorithmicMedia' as const;
const COMPOSITE = 'compositeWithTrainedAlgorithmicMedia' as const;
const pixels = () => sharp({ create: { width: 9, height: 7, channels: 3, background: { r: 200, g: 120, b: 40 } } });
const sources = {
  'image/jpeg': () => pixels().jpeg().toBuffer(),
  'image/png': () => pixels().png().toBuffer(),
  'image/webp': () => pixels().webp({ lossless: false }).toBuffer(),
};
const lossless = () => sharp({ create: { width: 5, height: 3, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 0.5 } } }).webp({ lossless: true }).toBuffer();
const reason = (mediaType: string, bytes: Uint8Array) => (error: unknown) => error instanceof ImageCarrierError && error.message === `provenance.image_${mediaType}` && bytes.length >= 0;

for (const [mediaType, make] of Object.entries(sources)) {
  test(`${mediaType}: an independent decoder reads the type and the same pixels`, async () => {
    const source = await make();
    assert.equal(readDigitalSourceType(source, mediaType), null);
    for (const type of [TRAINED, COMPOSITE]) {
      const carried = carryDigitalSourceType(source, mediaType, type);
      assert.equal(readDigitalSourceType(carried, mediaType), digitalSourceTypeUri(type));
      const metadata = await sharp(carried).metadata();
      assert.equal(metadata.width, 9); assert.equal(metadata.height, 7);
      assert.ok(metadata.xmp, 'the decoder finds the XMP packet');
      assert.ok(metadata.xmp!.toString('utf8').includes(`<Iptc4xmpExt:DigitalSourceType>${digitalSourceTypeUri(type)}</Iptc4xmpExt:DigitalSourceType>`));
      assert.deepEqual(await sharp(carried).raw().toBuffer(), await sharp(source).raw().toBuffer(), 'the image data is untouched');
      assert.equal(inspect(carried, { bytes: carried.length, sha256: sha256Hex(carried), mediaType, classification: 'public' }), null, 'the labelled copy passes the file scan');
    }
  });

  test(`${mediaType}: a file already carrying the type is returned as it is; another type replaces it, once`, async () => {
    const once = carryDigitalSourceType(await make(), mediaType, TRAINED);
    assert.equal(carryDigitalSourceType(once, mediaType, TRAINED), once);
    const replaced = carryDigitalSourceType(once, mediaType, COMPOSITE);
    assert.equal(readDigitalSourceType(replaced, mediaType), digitalSourceTypeUri(COMPOSITE));
    assert.equal(Buffer.from(replaced).toString('latin1').split('DigitalSourceType>').length, 3, 'one element: an open and a close tag');
    assert.ok((await sharp(replaced).metadata()).xmp);
  });

  test(`${mediaType}: truncated and corrupted files are refused, never mislabelled or looped on`, async () => {
    const source = await make();
    for (const length of [0, 1, 2, 3, 8, 11, 12, 13, 20]) {
      assert.throws(() => carryDigitalSourceType(source.subarray(0, length), mediaType, TRAINED), reason('malformed_image', source));
    }
    assert.throws(() => carryDigitalSourceType(Buffer.from('not an image at all, only text'), mediaType, TRAINED), reason('malformed_image', source));
  });
}

test('lossless WebP with alpha gains the extended header with the right canvas and alpha flag', async () => {
  const source = await lossless();
  const carried = carryDigitalSourceType(source, 'image/webp', TRAINED);
  const metadata = await sharp(carried).metadata();
  assert.equal(metadata.width, 5); assert.equal(metadata.height, 3); assert.equal(metadata.hasAlpha, true);
  assert.deepEqual(await sharp(carried).raw().toBuffer(), await sharp(source).raw().toBuffer());
});

test('a WebP that already has the extended header keeps its other chunks', async () => {
  const withExif = await sharp(await lossless()).withExif({ IFD0: { Copyright: 'Synthetic' } }).webp({ lossless: true }).toBuffer();
  const carried = carryDigitalSourceType(withExif, 'image/webp', TRAINED);
  assert.equal(readDigitalSourceType(carried, 'image/webp'), digitalSourceTypeUri(TRAINED));
  assert.ok((await sharp(carried).metadata()).exif, 'EXIF survives');
});

test('JPEG keeps JFIF first and EXIF in place; only earlier XMP is replaced', async () => {
  const withExif = await pixels().jpeg().withExif({ IFD0: { Copyright: 'Synthetic' } }).toBuffer();
  const carried = Buffer.from(carryDigitalSourceType(withExif, 'image/jpeg', TRAINED));
  assert.equal(carried[0], 0xff); assert.equal(carried[1], 0xd8);
  if (withExif[3] === 0xe0) assert.equal(carried[3], 0xe0, 'APP0 stays first');
  assert.ok((await sharp(carried).metadata()).exif, 'EXIF survives');
});

test('a declared type overrides what a tool wrote, in the attribute form too', async () => {
  const foreign = xmpPacket(TRAINED).replace(/<Iptc4xmpExt:DigitalSourceType>.*<\/Iptc4xmpExt:DigitalSourceType>/, '').replace('rdf:about=""', 'rdf:about="" Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture"');
  const source = await pixels().png().withXmp(foreign).toBuffer();
  assert.equal(readDigitalSourceType(source, 'image/png'), 'http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture');
  assert.equal(readDigitalSourceType(carryDigitalSourceType(source, 'image/png', TRAINED), 'image/png'), digitalSourceTypeUri(TRAINED));
});

test('a compressed PNG packet is read and replaced, not left beside the new one', async () => {
  const source = await pixels().png().withXmp(xmpPacket(COMPOSITE)).toBuffer();
  assert.equal(readDigitalSourceType(source, 'image/png'), digitalSourceTypeUri(COMPOSITE));
  const carried = carryDigitalSourceType(source, 'image/png', TRAINED);
  assert.equal(Buffer.from(carried).includes('zTXt', 0, 'latin1'), false);
  assert.equal((await sharp(carried).metadata()).xmp?.toString('utf8').includes(digitalSourceTypeUri(TRAINED)), true);
});

test('a C2PA manifest in the file is refused rather than broken, in every container', async () => {
  const chunk = (type: string) => { const b = Buffer.alloc(12); b.write(type, 4, 'latin1'); return b; };
  const png = await sources['image/png']();
  const pngWith = Buffer.concat([png.subarray(0, 33), chunk('caBX'), png.subarray(33)]);
  assert.throws(() => carryDigitalSourceType(pngWith, 'image/png', TRAINED), /existing_credentials/);
  const jpeg = await sources['image/jpeg']();
  const app11 = Buffer.concat([Buffer.from([0xff, 0xeb, 0x00, 0x0a]), Buffer.from('JPc2pa\0\0', 'latin1')]);
  assert.throws(() => carryDigitalSourceType(Buffer.concat([jpeg.subarray(0, 2), app11, jpeg.subarray(2)]), 'image/jpeg', TRAINED), /existing_credentials/);
  const webp = await lossless();
  const riff = Buffer.concat([webp, Buffer.from('C2PA\x02\0\0\0ab', 'latin1')]);
  riff.writeUInt32LE(riff.length - 8, 4);
  assert.throws(() => carryDigitalSourceType(riff, 'image/webp', TRAINED), /existing_credentials/);
});

test('an unlisted media type has no carrier', () => {
  assert.throws(() => carryDigitalSourceType(Buffer.from('%PDF-1.7'), 'application/pdf', TRAINED), /unsupported_type/);
});
