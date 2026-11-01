import { createHash } from 'node:crypto';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import type { Readable } from 'node:stream';
import type { Transaction } from '../../deps/data.js';
import type { RequestState } from '../../common/request.js';
import { ApiError } from '../../common/errors.js';
import type { BlobStore } from './deps.js';
import { files } from './deps.js';
import type { FilesService } from './files.service.js';

/** Local owning export adapter: memory is bounded independently of object size; no storage key leaves this callback. */
export async function withOwnPrivacyFile<T>(input: {
  trx: Transaction; state: RequestState; subject: { kind: 'person' | 'company'; id: string }; id: string; store: BlobStore | null; service: FilesService;
}, consume: (file: { stream: Readable; bytes: number; sha256: string }) => Promise<T>): Promise<T> {
  const { trx, state, subject, id, store, service } = input;
  if (!store || store.kind !== 'filesystem' || !store.stream) throw new ApiError('validation.schema', 'streaming storage unavailable');
  await sql`SELECT trustwork.files_privacy_export_lock(${id}::uuid)`.execute(trx);
  await service.get(id, state); // The same owning serializer and private ceiling as the normal file read.
  const row = await files.get(trx, id);
  if (!row || (subject.kind === 'person' ? row.owner_person_id : row.owner_company_id) !== subject.id) throw new ApiError('access.not_found');
  const size = Number(row.bytes);
  if (!Number.isSafeInteger(size) || size < 0) throw new ApiError('validation.schema', 'invalid file size');
  const directory = await mkdtemp(join(tmpdir(), 'trustwork-private-export-'));
  try {
    const file = await open(join(directory, 'verified-content'), 'wx+', 0o600);
    try {
      const hash = createHash('sha256'); let written = 0;
      for await (const chunk of store.stream(row.storage_key)) {
        written += chunk.length;
        if (written > size || chunk.length > 1024 * 1024) throw new Error('privacy file stream exceeds its declared bound');
        hash.update(chunk); await file.writeFile(chunk);
      }
      if (written !== size || hash.digest('hex') !== row.sha256) throw new Error('privacy file digest verification failed');
      // Nothing reaches the response before full verification; use the same open descriptor, never a re-opened source path.
      const stream = file.createReadStream({ start: 0, autoClose: false, highWaterMark: 64 * 1024 });
      try { return await consume({ stream, bytes: written, sha256: row.sha256 }); } finally { stream.destroy(); }
    } finally { await file.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}
