import { crc32, inflateSync } from 'node:zlib';
import { digitalSourceTypeUri, type DigitalSourceType } from '../../../../packages/contracts/src/provenance.js';

/**
 * IPTC digital source type written into the image file itself, as the XMP property `Iptc4xmpExt:DigitalSourceType`
 * (PROV-001). Plain container edits for the three image types the file module accepts: no decoding, no re-encoding,
 * no dependency and no key. The pixels are copied byte for byte. This is a label that travels with the file, not a
 * signature: anyone can strip or rewrite it, which is why C2PA signing stays a separate adapter.
 */
export class ImageCarrierError extends Error {
  constructor(readonly reason: 'unsupported_type' | 'malformed_image' | 'existing_credentials') {
    super(`provenance.image_${reason}`);
    this.name = 'ImageCarrierError';
  }
}

const malformed = (): never => { throw new ImageCarrierError('malformed_image'); };
const latin1 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
const utf8 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
const startsWith = (bytes: Uint8Array, text: string, at = 0) => latin1(bytes.subarray(at, at + text.length)) === text;

/** An XMP packet holding exactly this one property. The URI comes from a closed vocabulary, so nothing needs escaping. */
export function xmpPacket(type: DigitalSourceType): string {
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">`
    + `<rdf:Description rdf:about="" xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"><Iptc4xmpExt:DigitalSourceType>${digitalSourceTypeUri(type)}</Iptc4xmpExt:DigitalSourceType></rdf:Description>`
    + `</rdf:RDF></x:xmpmeta><?xpacket end="r"?>`;
}
const sourceTypeIn = (packet: string) => /DigitalSourceType(?:>|\s*=\s*["'])\s*([^<"'\s]+)/.exec(packet)?.[1] ?? null;

interface Container {
  /** The first XMP packet, or null. */
  xmp(bytes: Uint8Array): string | null;
  /** True when the file holds a C2PA manifest. Any byte change would break its hard binding. */
  credentials(bytes: Uint8Array): boolean;
  /** The same image with `packet` as its only XMP. */
  write(bytes: Uint8Array, packet: string): Uint8Array;
}

/* ---------- JPEG: an APP1 segment ---------- */

const JPEG_XMP = 'http://ns.adobe.com/xap/1.0/\0';
const JPEG_XMP_EXTENSION = 'http://ns.adobe.com/xmp/extension/\0';
interface Segment { marker: number; start: number; end: number }

/** Marker segments before the scan data; returns where the scan begins. Everything from there on is copied unread. */
function jpegSegments(bytes: Uint8Array): { segments: Segment[]; scan: number } {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) malformed();
  const segments: Segment[] = [];
  let at = 2;
  for (;;) {
    if (at + 4 > bytes.length || bytes[at] !== 0xff) return malformed();
    const marker = bytes[at + 1]!;
    if (marker === 0xff) { at += 1; continue; }
    if (marker === 0xda) return { segments, scan: at };
    if (marker === 0xd9 || marker === 0xd8 || marker === 0x00) return malformed();
    const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
    if (length < 2 || at + 2 + length > bytes.length) return malformed();
    segments.push({ marker, start: at, end: at + 2 + length });
    at += 2 + length;
  }
}
const jpegPayload = (bytes: Uint8Array, s: Segment) => bytes.subarray(s.start + 4, s.end);
const isJpegXmp = (bytes: Uint8Array, s: Segment) => s.marker === 0xe1 && (startsWith(jpegPayload(bytes, s), JPEG_XMP) || startsWith(jpegPayload(bytes, s), JPEG_XMP_EXTENSION));
const jpeg: Container = {
  xmp(bytes) {
    const found = jpegSegments(bytes).segments.find(s => s.marker === 0xe1 && startsWith(jpegPayload(bytes, s), JPEG_XMP));
    return found ? utf8(jpegPayload(bytes, found).subarray(JPEG_XMP.length)) : null;
  },
  credentials(bytes) {
    return jpegSegments(bytes).segments.some(s => s.marker === 0xeb && latin1(jpegPayload(bytes, s)).includes('c2pa'));
  },
  write(bytes, packet) {
    const { segments, scan } = jpegSegments(bytes);
    const payload = Buffer.concat([Buffer.from(JPEG_XMP, 'latin1'), Buffer.from(packet, 'utf8')]);
    if (payload.length + 2 > 0xffff) malformed();
    const segment = Buffer.concat([Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
    const kept = segments.filter(s => !isJpegXmp(bytes, s));
    // JFIF requires its APP0 to come first; the XMP follows it.
    const lead = kept[0]?.marker === 0xe0 ? 1 : 0;
    const slice = (s: Segment) => bytes.subarray(s.start, s.end);
    return Buffer.concat([bytes.subarray(0, 2), ...kept.slice(0, lead).map(slice), segment, ...kept.slice(lead).map(slice), bytes.subarray(scan)]);
  },
};

/* ---------- PNG: an iTXt chunk ---------- */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_XMP = 'XML:com.adobe.xmp';
interface Chunk { type: string; start: number; data: number; end: number }

function pngChunks(bytes: Uint8Array): Chunk[] {
  if (!PNG_SIGNATURE.equals(bytes.subarray(0, 8))) malformed();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Chunk[] = [];
  let at = 8;
  while (at < bytes.length) {
    if (at + 12 > bytes.length) malformed();
    const length = view.getUint32(at);
    const end = at + 12 + length;
    if (end > bytes.length) malformed();
    chunks.push({ type: latin1(bytes.subarray(at + 4, at + 8)), start: at, data: at + 8, end });
    at = end;
  }
  if (chunks[0]?.type !== 'IHDR' || chunks.at(-1)?.type !== 'IEND') malformed();
  return chunks;
}
// Some encoders, libvips among them, store the packet compressed in zTXt under the same keyword.
const isPngXmp = (bytes: Uint8Array, c: Chunk) => (c.type === 'iTXt' || c.type === 'zTXt') && startsWith(bytes, `${PNG_XMP}\0`, c.data);
const PNG_XMP_LIMIT = 1 << 20;
function pngInflate(data: Uint8Array): string {
  try {
    return utf8(inflateSync(data, { maxOutputLength: PNG_XMP_LIMIT }));
  } catch {
    return malformed();
  }
}
function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}
const png: Container = {
  xmp(bytes) {
    const found = pngChunks(bytes).find(c => isPngXmp(bytes, c));
    if (!found) return null;
    const body = bytes.subarray(found.data + PNG_XMP.length + 1, found.end - 4);
    // zTXt: keyword NUL, compression method, data.
    if (found.type === 'zTXt') return pngInflate(body.subarray(1));
    // iTXt: keyword NUL, compression flag, compression method, language NUL, translated keyword NUL, text.
    let at = 2;
    for (let nulls = 0; nulls < 2; at += 1) {
      if (at >= body.length) return malformed();
      if (body[at] === 0) nulls += 1;
    }
    return body[0] === 0 ? utf8(body.subarray(at)) : pngInflate(body.subarray(at));
  },
  credentials(bytes) {
    return pngChunks(bytes).some(c => c.type === 'caBX');
  },
  write(bytes, packet) {
    const chunks = pngChunks(bytes);
    const chunk = pngChunk('iTXt', Buffer.concat([Buffer.from(`${PNG_XMP}\0\0\0\0\0`, 'latin1'), Buffer.from(packet, 'utf8')]));
    const rest = chunks.slice(1).filter(c => !isPngXmp(bytes, c)).map(c => bytes.subarray(c.start, c.end));
    return Buffer.concat([bytes.subarray(0, chunks[0]!.end), chunk, ...rest]);
  },
};

/* ---------- WebP: an XMP chunk, which needs the extended VP8X header ---------- */

const VP8X_XMP = 0x04;
const VP8X_ALPHA = 0x10;
function webpChunks(bytes: Uint8Array): Chunk[] {
  if (!startsWith(bytes, 'RIFF') || !startsWith(bytes, 'WEBP', 8)) malformed();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const limit = view.getUint32(4, true) + 8;
  if (limit > bytes.length) malformed();
  const chunks: Chunk[] = [];
  let at = 12;
  while (at < limit) {
    if (at + 8 > limit) malformed();
    const size = view.getUint32(at + 4, true);
    const end = at + 8 + size + (size % 2);
    if (at + 8 + size > limit) malformed();
    chunks.push({ type: latin1(bytes.subarray(at, at + 4)), start: at, data: at + 8, end: Math.min(end, limit) });
    at = end;
  }
  if (!chunks.length) malformed();
  return chunks;
}
function webpChunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.write(type, 0, 'latin1');
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, Buffer.alloc(data.length % 2)]);
}
/** The extended header a simple WebP lacks: canvas size and alpha come from its single image chunk. */
function webpExtendedHeader(bytes: Uint8Array, image: Chunk): Buffer {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width: number, height: number, flags = VP8X_XMP;
  if (image.type === 'VP8 ') {
    if (image.data + 10 > image.end || bytes[image.data + 3] !== 0x9d || bytes[image.data + 4] !== 0x01 || bytes[image.data + 5] !== 0x2a) return malformed();
    width = view.getUint16(image.data + 6, true) & 0x3fff;
    height = view.getUint16(image.data + 8, true) & 0x3fff;
  } else if (image.type === 'VP8L') {
    if (image.data + 5 > image.end || bytes[image.data] !== 0x2f) return malformed();
    const bits = view.getUint32(image.data + 1, true);
    width = (bits & 0x3fff) + 1;
    height = ((bits >>> 14) & 0x3fff) + 1;
    if ((bits >>> 28) & 1) flags |= VP8X_ALPHA;
  } else return malformed();
  const data = Buffer.alloc(10);
  data[0] = flags;
  data.writeUIntLE(width - 1, 4, 3);
  data.writeUIntLE(height - 1, 7, 3);
  return webpChunk('VP8X', data);
}
const webp: Container = {
  xmp(bytes) {
    const found = webpChunks(bytes).find(c => c.type === 'XMP ');
    if (!found) return null;
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(found.start + 4, true);
    return utf8(bytes.subarray(found.data, found.data + size));
  },
  credentials(bytes) {
    return webpChunks(bytes).some(c => c.type === 'C2PA');
  },
  write(bytes, packet) {
    const chunks = webpChunks(bytes);
    const first = chunks[0]!;
    const kept = chunks.filter(c => c.type !== 'XMP ');
    const slice = (c: Chunk) => bytes.subarray(c.start, c.end);
    const parts: Uint8Array[] = [];
    if (first.type === 'VP8X') {
      const header = Buffer.from(slice(first));
      header[8] = header[8]! | VP8X_XMP;
      parts.push(header, ...kept.slice(1).map(slice));
    } else parts.push(webpExtendedHeader(bytes, first), ...kept.map(slice));
    parts.push(webpChunk('XMP ', Buffer.from(packet, 'utf8')));
    const body = Buffer.concat(parts);
    const head = Buffer.alloc(12);
    head.write('RIFF', 0, 'latin1');
    head.writeUInt32LE(body.length + 4, 4);
    head.write('WEBP', 8, 'latin1');
    return Buffer.concat([head, body]);
  },
};

const CONTAINERS: Record<string, Container> = { 'image/jpeg': jpeg, 'image/png': png, 'image/webp': webp };
function container(mediaType: string): Container {
  const found = CONTAINERS[mediaType];
  if (!found) throw new ImageCarrierError('unsupported_type');
  return found;
}

/** The digital source type URI the file carries, or null. */
export function readDigitalSourceType(bytes: Uint8Array, mediaType: string): string | null {
  const packet = container(mediaType).xmp(bytes);
  return packet === null ? null : sourceTypeIn(packet);
}

/**
 * The image carrying `type`. A file that already carries it comes back unchanged. Any earlier XMP is replaced, because a
 * person's declaration outranks what a tool wrote; a file with a C2PA manifest is refused rather than silently broken.
 */
export function carryDigitalSourceType(bytes: Uint8Array, mediaType: string, type: DigitalSourceType): Uint8Array {
  const format = container(mediaType);
  if (readDigitalSourceType(bytes, mediaType) === digitalSourceTypeUri(type)) return bytes;
  if (format.credentials(bytes)) throw new ImageCarrierError('existing_credentials');
  const carried = format.write(bytes, xmpPacket(type));
  if (readDigitalSourceType(carried, mediaType) !== digitalSourceTypeUri(type)) malformed();
  return carried;
}
