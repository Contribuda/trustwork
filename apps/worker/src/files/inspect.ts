import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

/**
 * Content checks of the scan job (FILE-001), run on the stored bytes before a file becomes visible. Pure functions with
 * bounded work: no decompression of documents (office files are stored, never unpacked), no external parser, no
 * interpretation of active content. Each check answers one question:
 *
 * - size and SHA-256 equal what the uploader declared (the signed PUT cannot change them unnoticed);
 * - the bytes look like the declared media type (magic numbers; UTF-8 without control bytes for text);
 * - an image carries GPS or location metadata (EXIF GPS IFD, XMP location properties) - refused only for `public`
 *   files: public projections never keep location, private parties keep their originals (EXE-F10).
 */
export type InspectionFailure = 'size_mismatch' | 'hash_mismatch' | 'type_mismatch' | 'location_metadata';

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0): boolean => prefix.every((b, i) => bytes[at + i] === b);
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const includesAscii = (bytes: Uint8Array, needle: string): boolean => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(needle, 0, 'latin1');

/** True when the bytes match the declared media type. */
export function matchesMediaType(bytes: Uint8Array, mediaType: string): boolean {
  switch (mediaType) {
    case 'image/jpeg':
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case 'image/png':
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/webp':
      return startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8);
    case 'application/pdf':
      return startsWith(bytes, ascii('%PDF-'));
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) && includesAscii(bytes, '[Content_Types].xml') && includesAscii(bytes, 'word/');
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) && includesAscii(bytes, '[Content_Types].xml') && includesAscii(bytes, 'xl/');
    case 'text/plain':
    case 'text/csv':
      return isPlainUtf8Text(bytes);
    default:
      return false;
  }
}

/** UTF-8 that decodes strictly and has no control bytes except tab, line feed, carriage return and form feed. */
export function isPlainUtf8Text(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  for (const b of bytes) if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c) return false;
  return !bytes.includes(0x7f);
}

/* ---------- Location metadata ---------- */

const GPS_IFD_TAG = 0x8825;
const XMP_LOCATION = /GPS(?:Latitude|Longitude|Altitude|Position|Coordinates)|Location(?:Shown|Created)|drone-dji:(?:Gps|Latitude|Longitude)/i;

/** EXIF (TIFF structure): true when IFD0 points to a GPS IFD with at least one entry. */
export function tiffHasGps(tiff: Uint8Array): boolean {
  if (tiff.length < 8) return false;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const order = String.fromCharCode(tiff[0] ?? 0, tiff[1] ?? 0);
  if (order !== 'II' && order !== 'MM') return false;
  const little = order === 'II';
  if (view.getUint16(2, little) !== 42) return false;
  const ifd0 = view.getUint32(4, little);
  if (ifd0 + 2 > tiff.length) return false;
  const count = view.getUint16(ifd0, little);
  for (let i = 0; i < count && i < 512; i++) {
    const at = ifd0 + 2 + i * 12;
    if (at + 12 > tiff.length) return false;
    if (view.getUint16(at, little) === GPS_IFD_TAG) {
      const gpsIfd = view.getUint32(at + 8, little);
      if (gpsIfd + 2 > tiff.length) return true; // a GPS pointer outside the block still declares location: refuse
      return view.getUint16(gpsIfd, little) > 0;
    }
  }
  return false;
}

function jpegHasLocation(bytes: Uint8Array): boolean {
  let at = 2;
  const exif = ascii('Exif\0\0');
  const xmp = ascii('http://ns.adobe.com/xap/1.0/\0');
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return false;
    const marker = bytes[at + 1] as number;
    if (marker === 0xd9 || marker === 0xda) return false; // end of image, start of scan: metadata segments are over
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const length = ((bytes[at + 2] as number) << 8) | (bytes[at + 3] as number);
    if (length < 2) return false;
    const start = at + 4;
    const end = Math.min(bytes.length, at + 2 + length);
    if (marker === 0xe1) {
      const segment = bytes.subarray(start, end);
      if (startsWith(segment, exif) && tiffHasGps(segment.subarray(6))) return true;
      if (startsWith(segment, xmp) && XMP_LOCATION.test(Buffer.from(segment).toString('utf8'))) return true;
    }
    at = at + 2 + length;
  }
  return false;
}

function pngHasLocation(bytes: Uint8Array): boolean {
  let at = 8;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (at + 12 <= bytes.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const data = bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + length));
    if (type === 'eXIf' && tiffHasGps(data)) return true;
    if (type === 'iTXt' || type === 'tEXt' || type === 'zTXt') {
      // Every text chunk is inspected whatever its keyword: XMP packets and ImageMagick "Raw profile type exif/app1"
      // (hex-encoded EXIF) both carry location.
      const nul = data.indexOf(0);
      const keyword = Buffer.from(data.subarray(0, nul < 0 ? 0 : nul)).toString('latin1');
      let text = Buffer.from(data.subarray(nul + 1)).toString('utf8');
      if (type === 'iTXt' && data[nul + 1] === 1) text = inflateBounded(data.subarray(nul + 3).subarray(skipTwoNulTerminated(data.subarray(nul + 3))));
      if (type === 'zTXt') text = inflateBounded(data.subarray(nul + 2));
      if (XMP_LOCATION.test(text)) return true;
      if (/^Raw profile type (exif|app1)$/i.test(keyword) && rawProfileHasGps(text)) return true;
    }
    if (type === 'IDAT' || type === 'IEND') return false;
    at += 12 + length;
  }
  return false;
}
/** ImageMagick raw profile: "\n<name>\n<length>\n<hex lines>"; the EXIF block starts at "Exif\0\0" or directly with TIFF. */
function rawProfileHasGps(text: string): boolean {
  const hex = text.split('\n').slice(3).join('').replace(/[^0-9a-fA-F]/g, '');
  const bytes = Buffer.from(hex.length % 2 ? hex.slice(0, -1) : hex, 'hex');
  const exif = bytes.indexOf(Buffer.from('Exif\0\0', 'latin1'));
  return tiffHasGps(exif >= 0 ? bytes.subarray(exif + 6) : bytes);
}
function skipTwoNulTerminated(data: Uint8Array): number {
  const first = data.indexOf(0);
  if (first < 0) return data.length;
  const second = data.indexOf(0, first + 1);
  return second < 0 ? data.length : second + 1;
}
function inflateBounded(data: Uint8Array): string {
  try {
    return inflateSync(data, { maxOutputLength: 1024 * 1024 }).toString('utf8');
  } catch {
    // Unreadable or oversized compressed metadata: treat as possibly carrying location.
    return 'GPSLatitude';
  }
}

function webpHasLocation(bytes: Uint8Array): boolean {
  let at = 12;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (at + 8 <= bytes.length) {
    const type = String.fromCharCode(...bytes.subarray(at, at + 4));
    const length = view.getUint32(at + 4, true);
    const data = bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + length));
    if (type === 'EXIF' && tiffHasGps(startsWith(data, ascii('Exif\0\0')) ? data.subarray(6) : data)) return true;
    if (type === 'XMP ' && XMP_LOCATION.test(Buffer.from(data).toString('utf8'))) return true;
    at += 8 + length + (length % 2);
  }
  return false;
}

/** True when an image declares GPS or location metadata. Non-images never do. */
export function hasLocationMetadata(bytes: Uint8Array, mediaType: string): boolean {
  if (mediaType === 'image/jpeg') return jpegHasLocation(bytes);
  if (mediaType === 'image/png') return pngHasLocation(bytes);
  if (mediaType === 'image/webp') return webpHasLocation(bytes);
  return false;
}

export interface Declared { bytes: number; sha256: string; mediaType: string; classification: string }

/** First failing content check, or null when the bytes are what the uploader declared and may be published as classified. */
export function inspect(bytes: Uint8Array, declared: Declared): InspectionFailure | null {
  if (bytes.byteLength !== declared.bytes) return 'size_mismatch';
  if (sha256Hex(bytes) !== declared.sha256) return 'hash_mismatch';
  if (!matchesMediaType(bytes, declared.mediaType)) return 'type_mismatch';
  if (declared.classification === 'public' && hasLocationMetadata(bytes, declared.mediaType)) return 'location_metadata';
  return null;
}
