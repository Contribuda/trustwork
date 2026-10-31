import { BlobStoreError, type BlobStore } from './blob-store.js';

/**
 * Tombstone ledger of deleted and erased files (FILE-001). Each tombstone is one small JSON object in object storage,
 * keyed by the artifact id, written BEFORE the bytes and the database row are removed. Object storage is outside the
 * restorable database snapshot: after a database restore the worker replays every tombstone
 * (`replayFileTombstones`), so a file that was deleted stays deleted. Operators should give the ledger its own bucket
 * (`FILES_TOMBSTONE_BUCKET`) with versioning or object lock where the provider offers it.
 *
 * A tombstone carries identifiers, the storage key and the reason only, never personal data. The shape is validated by
 * the caller with `FileTombstoneSchema` (packages/contracts/src/files.ts).
 */
export interface TombstoneRecord {
  v: 1;
  artifactId: string;
  storageKey: string;
  reason: 'deleted' | 'erased';
  privacyRequestId: string | null;
  recordedAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const TOMBSTONE_PREFIX = 'tombstones/';

export class TombstoneLedger {
  constructor(private readonly store: BlobStore, private readonly prefix: string = TOMBSTONE_PREFIX) {}

  private keyOf(artifactId: string): string {
    if (!UUID.test(artifactId)) throw new BlobStoreError('tombstone artifact id must be a lowercase uuid');
    return `${this.prefix}${artifactId}.json`;
  }

  /** Idempotent per artifact: writing the same tombstone again keeps the first record. */
  async record(tombstone: TombstoneRecord, signal?: AbortSignal): Promise<void> {
    const key = this.keyOf(tombstone.artifactId);
    if (await this.store.head(key, signal)) return;
    await this.store.put(key, new TextEncoder().encode(JSON.stringify(tombstone)), 'application/json', signal);
  }

  async get(artifactId: string, signal?: AbortSignal): Promise<unknown | null> {
    const body = await this.store.read(this.keyOf(artifactId), 64 * 1024, signal);
    return body ? (JSON.parse(new TextDecoder().decode(body)) as unknown) : null;
  }

  /** Every tombstone, oldest key order (artifact ids); unparsable entries are returned as errors for the operator. */
  async all(signal?: AbortSignal): Promise<{ key: string; value: unknown }[]> {
    const keys = (await this.store.list(this.prefix, signal)).filter((k) => k.endsWith('.json'));
    const out: { key: string; value: unknown }[] = [];
    for (const key of keys) {
      const body = await this.store.read(key, 64 * 1024, signal);
      if (!body) continue;
      try {
        out.push({ key, value: JSON.parse(new TextDecoder().decode(body)) as unknown });
      } catch (error) {
        out.push({ key, value: { error: (error as Error).message } });
      }
    }
    return out;
  }
}
