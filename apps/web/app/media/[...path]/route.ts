import { createReadStream, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { NextRequest } from 'next/server';
import { primeLocale } from '@/app/_lib/locale';

/**
 * Serves `packages/ui/media/{photos,artworks}` at `/media/*`, the default base of `coverFor()` /
 * `MediaFrame`, without a copy step: `next dev`, `next build` + `next start` and the Playwright run
 * all read the files straight from the workspace. Only the two known folders and the two known
 * extensions are reachable; anything else (including traversal attempts) is 404.
 */
const MEDIA_ROOT = resolve(process.cwd(), process.cwd().endsWith(`${sep}apps${sep}web`) ? '../../packages/ui/media' : 'packages/ui/media');
const FOLDERS = new Set(['photos', 'artworks']);
const TYPES: Record<string, string> = { '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const SAFE_NAME = /^[a-z0-9-]+(?:\.[a-z0-9]+)?$/;

export async function GET(_request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  await primeLocale();
  const { path } = await context.params;
  const [folder, name, ...rest] = path;
  if (!folder || !name || rest.length || !FOLDERS.has(folder) || !SAFE_NAME.test(name)) return new Response(null, { status: 404 });
  const extension = name.slice(name.lastIndexOf('.'));
  const type = TYPES[extension];
  if (!type) return new Response(null, { status: 404 });
  const file = resolve(MEDIA_ROOT, folder, name);
  if (!file.startsWith(MEDIA_ROOT + sep)) return new Response(null, { status: 404 });
  let size: number;
  try {
    const stats = statSync(file);
    if (!stats.isFile()) return new Response(null, { status: 404 });
    size = stats.size;
  } catch {
    return new Response(null, { status: 404 });
  }
  const stream = Readable.toWeb(createReadStream(file)) as ReadableStream;
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': type,
      'Content-Length': String(size),
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
