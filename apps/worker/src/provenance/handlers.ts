import { createHash } from 'node:crypto';
import { z } from 'zod';
import { inbox, type DataPool } from '@trustwork/data';
import { DigitalSourceTypeSchema } from '../../../../packages/contracts/src/provenance.js';
import type { ImageProvenanceInput } from '../../../../packages/contracts/src/provenance-image.js';
import { BlobStoreUnavailableError, BlobTooLargeError, type BlobStore } from '../../../../packages/data/src/files/index.js';
import { provenanceWorker } from '../../../../packages/data/src/repositories/provenance.js';
import { inTransaction } from '../db.js';
import { PermanentJobError, RetryableJobError, type HandlerRegistry, type JobContext } from '../handlers.js';
import { carryImage, UnavailableC2paIptcAdapter, type C2paIptcAdapter } from './image-adapter.js';
import { ImageCarrierError } from './xmp.js';

/**
 * Labels generated and AI-edited images (PROV-001). The API records the person's request in the outbox; this job reads
 * the private source, writes the IPTC digital source type into a copy and stores it as a new public file, which then
 * goes through the ordinary `files.scan`. Every storage effect is idempotent (the same bytes to a fixed key), so an
 * unreachable store is a retry, never an unknown outcome; a file that cannot be labelled is a recorded failure.
 */
export const PROVENANCE_IMAGE_KIND = 'provenance.image_carry';
export const PROVENANCE_IMAGE_ATTEMPTS = 8;
const Payload = z.strictObject({ imageId: z.uuid() });
type Payload = z.infer<typeof Payload>;

export interface ProvenanceImagesRuntime {
  pool: DataPool;
  store: BlobStore;
  /** C2PA signing. Defaults to unavailable: the image still carries its IPTC type, without a manifest. */
  adapter?: C2paIptcAdapter;
}

function storageFailure(error: unknown): never {
  if (error instanceof BlobStoreUnavailableError) throw new RetryableJobError(`provenance image: ${error.message}`, { cause: error });
  throw error;
}

export function registerProvenanceImages(registry: HandlerRegistry, runtime: ProvenanceImagesRuntime): void {
  const { pool, store } = runtime;
  const adapter = runtime.adapter ?? new UnavailableC2paIptcAdapter();
  registry.onOutbox({
    name: 'provenance.image_enqueue',
    type: 'provenance.image_requested',
    parse: (payload) => Payload.parse(payload),
    handle: async (event, context) => {
      if (event.aggregateKind !== 'provenance_image' || event.aggregateId !== event.payload.imageId) throw new PermanentJobError(`malformed provenance image event ${event.id}`);
      const { fresh } = await inbox.record(context.trx, { provider: 'outbox', account: 'provenance.image_requested', event_id: event.payload.imageId });
      if (fresh) await context.enqueue({ kind: PROVENANCE_IMAGE_KIND, payload: { imageId: event.payload.imageId }, maxAttempts: PROVENANCE_IMAGE_ATTEMPTS });
    },
  });
  registry.onJob({
    kind: PROVENANCE_IMAGE_KIND,
    mode: 'external',
    parse: (payload) => Payload.parse(payload),
    run: async (context: JobContext<Payload>) => {
      const id = context.payload.imageId;
      const fail = (failure: string) => inTransaction(pool, (trx) => provenanceWorker.imageFail(trx, id, failure));
      const target = await inTransaction(pool, (trx) => provenanceWorker.imageTarget(trx, id));
      if (!target || target.status !== 'pending') return;
      if (target.storage_key === null || target.asset_id === null) return void await fail('source_unavailable');
      let source: Uint8Array | null;
      try {
        source = await store.read(target.storage_key, Number(target.bytes), context.signal);
      } catch (error) {
        if (error instanceof BlobTooLargeError) return void await fail('hash_mismatch');
        storageFailure(error);
      }
      if (source === null) return void await fail('source_unavailable');
      if (createHash('sha256').update(source).digest('hex') !== target.source_sha256) return void await fail('hash_mismatch');
      const input: ImageProvenanceInput = {
        binding: { publicationId: target.publication_id, version: target.version, digest: { algorithm: 'trustwork-digest-1', value: target.version_digest } },
        provenanceId: target.provenance_id, assetId: target.asset_id, assetSha256: target.source_sha256,
        digitalSourceType: DigitalSourceTypeSchema.parse(target.digital_source_type), depictsRealPerson: false, documentary: false,
      };
      let carried: Awaited<ReturnType<typeof carryImage>>;
      try {
        carried = await carryImage(source, target.media_type, input, adapter);
      } catch (error) {
        if (error instanceof ImageCarrierError) return void await fail(error.reason);
        throw error;
      }
      const key = `provenance/${id}`;
      try {
        await store.put(key, carried.image, target.media_type, context.signal);
      } catch (error) {
        storageFailure(error);
      }
      const sha256 = createHash('sha256').update(carried.image).digest('hex');
      await inTransaction(pool, (trx) => provenanceWorker.imageComplete(trx, id, { key, sha256, bytes: carried.image.byteLength, credentials: carried.credentials }));
    },
  });
}
