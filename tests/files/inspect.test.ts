import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { hasLocationMetadata, inspect, isPlainUtf8Text, matchesMediaType, tiffHasGps } from '../../apps/worker/src/files/inspect.js';
import { EICAR_TEST_STRING, FakeMalwareScanner } from '../../apps/worker/src/files/scanner.js';
import { exifTiff, jpeg, png, pngChunk, sha } from './helpers.js';

/**
 * FILE-001 content checks of the scan job: magic numbers per accepted type, strict UTF-8 text, location metadata in
 * JPEG (EXIF GPS IFD, XMP), PNG (eXIf, tEXt/iTXt XMP, compressed) and WebP (EXIF chunk), malformed input, and the order of
 * the checks. The checks never unpack documents and never interpret active content.
 */
const ascii = (s: string) => new TextEncoder().encode(s);

function webp(chunks: { type: string; data: Uint8Array }[]): Uint8Array {
  const body = chunks.flatMap(({ type, data }) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'latin1');
    head.writeUInt32LE(data.length, 4);
    return [head, Buffer.from(data), ...(data.length % 2 ? [Buffer.alloc(1)] : [])];
  });
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(4 + body.reduce((n, b) => n + b.length, 0), 4);
  riff.write('WEBP', 8, 'latin1');
  return Buffer.concat([riff, ...body]);
}
const zip = (entries: string[]) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(entries.join('\0'), 'latin1')]);

test('magic numbers and text rules per accepted media type', () => {
  assert.ok(matchesMediaType(png(), 'image/png'));
  assert.ok(matchesMediaType(jpeg(), 'image/jpeg'));
  assert.ok(matchesMediaType(webp([{ type: 'VP8 ', data: new Uint8Array(10) }]), 'image/webp'));
  assert.ok(matchesMediaType(ascii('%PDF-1.7\n'), 'application/pdf'));
  assert.ok(matchesMediaType(zip(['[Content_Types].xml', 'word/document.xml']), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
  assert.ok(matchesMediaType(zip(['[Content_Types].xml', 'xl/workbook.xml']), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
  assert.ok(!matchesMediaType(zip(['[Content_Types].xml', 'xl/workbook.xml']), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'a spreadsheet is not a document');
  assert.ok(!matchesMediaType(zip(['payload.exe']), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'an arbitrary archive is not an office file');
  assert.ok(matchesMediaType(ascii('date,amount\n2026-11-01,10\n'), 'text/csv'));
  assert.ok(matchesMediaType(ascii('Line one\r\n\tindented\n'), 'text/plain'));
  assert.ok(!matchesMediaType(ascii('<svg onload=alert(1)>'), 'image/png'));
  assert.ok(!matchesMediaType(png(), 'image/jpeg'));
  assert.ok(!matchesMediaType(ascii('MZ\x90\x00'), 'application/pdf'));
  assert.ok(!matchesMediaType(png(), 'image/svg+xml'), 'unknown types never match');
  assert.ok(!isPlainUtf8Text(new Uint8Array([0x68, 0x00, 0x69])), 'NUL byte');
  assert.ok(!isPlainUtf8Text(new Uint8Array([0xc3, 0x28])), 'invalid UTF-8');
  assert.ok(!isPlainUtf8Text(ascii('escape \x1b[31m')), 'terminal control sequence');
  assert.ok(isPlainUtf8Text(new TextEncoder().encode('Precio: 10 €, señor')), 'non-ASCII text is fine');
  assert.ok(!matchesMediaType(new Uint8Array(), 'image/png'));
});

test('location metadata: EXIF GPS and XMP in JPEG, PNG and WebP', () => {
  assert.ok(tiffHasGps(exifTiff(true)));
  assert.ok(!tiffHasGps(exifTiff(false)));
  assert.ok(hasLocationMetadata(jpeg(exifTiff(true)), 'image/jpeg'));
  assert.ok(!hasLocationMetadata(jpeg(exifTiff(false)), 'image/jpeg'), 'EXIF without GPS (camera make) is fine');
  assert.ok(!hasLocationMetadata(jpeg(), 'image/jpeg'));
  const xmpSegment = (text: string) => {
    const payload = Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'), Buffer.from(text)]);
    const head = Buffer.from([0xff, 0xe1, 0, 0]);
    head.writeUInt16BE(payload.length + 2, 2);
    return Buffer.concat([Buffer.from([0xff, 0xd8]), head, payload, Buffer.from([0xff, 0xda, 0x00, 0x02, 0xff, 0xd9])]);
  };
  assert.ok(hasLocationMetadata(xmpSegment('<rdf:Description exif:GPSLatitude="37,46.5N"/>'), 'image/jpeg'));
  assert.ok(!hasLocationMetadata(xmpSegment('<rdf:Description dc:creator="Fixture"/>'), 'image/jpeg'));

  assert.ok(hasLocationMetadata(png([pngChunk('eXIf', exifTiff(true))]), 'image/png'));
  assert.ok(!hasLocationMetadata(png([pngChunk('eXIf', exifTiff(false))]), 'image/png'));
  const itxt = (compressed: boolean, text: string) => pngChunk('iTXt', Buffer.concat([
    Buffer.from('XML:com.adobe.xmp\0', 'latin1'), Buffer.from([compressed ? 1 : 0, 0]), Buffer.from('\0\0', 'latin1'), compressed ? deflateSync(Buffer.from(text)) : Buffer.from(text),
  ]));
  assert.ok(hasLocationMetadata(png([itxt(false, '<x exif:GPSLongitude="122,25W"/>')]), 'image/png'));
  assert.ok(hasLocationMetadata(png([itxt(true, '<x photoshop:LocationShown="site"/>')]), 'image/png'), 'compressed XMP is inflated (bounded)');
  assert.ok(!hasLocationMetadata(png([itxt(true, '<x dc:title="Deck"/>')]), 'image/png'));
  assert.ok(hasLocationMetadata(png([pngChunk('zTXt', Buffer.concat([Buffer.from('Comment\0\0', 'latin1'), Buffer.from('not deflate data')]))]), 'image/png'), 'unreadable compressed metadata is treated as location');
  const rawProfile = (tiff: Uint8Array) => `\nexif\n${tiff.length + 6}\n${Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from(tiff)]).toString('hex').replace(/(.{72})/g, '$1\n')}\n`;
  assert.ok(hasLocationMetadata(png([pngChunk('zTXt', Buffer.concat([Buffer.from('Raw profile type exif\0\0', 'latin1'), deflateSync(Buffer.from(rawProfile(exifTiff(true))))]))]), 'image/png'), 'hex-encoded EXIF of ImageMagick');
  assert.ok(!hasLocationMetadata(png([pngChunk('zTXt', Buffer.concat([Buffer.from('Raw profile type exif\0\0', 'latin1'), deflateSync(Buffer.from(rawProfile(exifTiff(false))))]))]), 'image/png'));

  assert.ok(hasLocationMetadata(webp([{ type: 'VP8 ', data: new Uint8Array(10) }, { type: 'EXIF', data: exifTiff(true) }]), 'image/webp'));
  assert.ok(hasLocationMetadata(webp([{ type: 'EXIF', data: Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from(exifTiff(true))]) }]), 'image/webp'));
  assert.ok(hasLocationMetadata(webp([{ type: 'XMP ', data: Buffer.from('<x drone-dji:GpsLatitude="1"/>') }]), 'image/webp'));
  assert.ok(!hasLocationMetadata(webp([{ type: 'EXIF', data: exifTiff(false) }]), 'image/webp'));
  assert.ok(!hasLocationMetadata(ascii('%PDF-1.7 GPSLatitude'), 'application/pdf'), 'only images are inspected for location');
});

test('malformed and truncated input never throws and never passes as clean metadata-free content by accident', () => {
  const truncated = jpeg(exifTiff(true)).subarray(0, 12);
  assert.doesNotThrow(() => hasLocationMetadata(truncated, 'image/jpeg'));
  const hostile = Buffer.from(exifTiff(true));
  hostile.writeUInt32LE(0xfffffff0, 4); // IFD0 offset far outside the block
  assert.equal(tiffHasGps(hostile), false);
  const pointerOut = Buffer.from(exifTiff(true));
  pointerOut.writeUInt32LE(0xfffffff0, 18); // GPS IFD pointer outside the block still declares location
  assert.equal(tiffHasGps(pointerOut), true);
  const giantLength = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from('eXIf', 'latin1')]);
  assert.doesNotThrow(() => hasLocationMetadata(giantLength, 'image/png'));
  for (let i = 0; i < 200; i += 1) {
    const noise = Buffer.from(Array.from({ length: 64 }, (_, j) => (i * 31 + j * 17) & 0xff));
    for (const type of ['image/jpeg', 'image/png', 'image/webp']) assert.doesNotThrow(() => hasLocationMetadata(Buffer.concat([type === 'image/jpeg' ? Buffer.from([0xff, 0xd8]) : Buffer.alloc(0), noise]), type));
  }
});

test('inspect: size, then hash, then type, then location for public images', () => {
  const bytes = png();
  const declared = { bytes: bytes.byteLength, sha256: sha(bytes), mediaType: 'image/png', classification: 'shared' };
  assert.equal(inspect(bytes, declared), null);
  assert.equal(inspect(bytes, { ...declared, bytes: bytes.byteLength + 1 }), 'size_mismatch');
  assert.equal(inspect(bytes, { ...declared, sha256: sha('other') }), 'hash_mismatch');
  assert.equal(inspect(bytes, { ...declared, mediaType: 'image/jpeg' }), 'type_mismatch');
  const located = jpeg(exifTiff(true));
  const photo = { bytes: located.byteLength, sha256: sha(located), mediaType: 'image/jpeg' };
  assert.equal(inspect(located, { ...photo, classification: 'public' }), 'location_metadata');
  for (const classification of ['shared', 'party_private', 'owner_private']) assert.equal(inspect(located, { ...photo, classification }), null, `${classification} keeps the original`);
});

test('fake malware scanner recognises the EICAR test file only', async () => {
  const scanner = new FakeMalwareScanner();
  assert.deepEqual(await scanner.scan(ascii(`prefix ${EICAR_TEST_STRING} suffix`)), { verdict: 'infected', signature: 'EICAR-Test-File' });
  assert.deepEqual(await scanner.scan(png()), { verdict: 'clean' });
  scanner.unavailable = true;
  await assert.rejects(scanner.scan(png()), /unavailable/);
  assert.equal(scanner.calls, 3);
});
