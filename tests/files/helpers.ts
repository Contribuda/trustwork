import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DataPool } from '@trustwork/data';
import { createApp, type CreatedApp } from '../../apps/api/src/app.js';
import { FakeOidcProvider } from '../../apps/api/src/modules/identity/ports.js';
import { AllowListFileMandates } from '../../apps/api/src/modules/files/mandates.js';
import { buildRegistry } from '../../apps/worker/src/main.js';
import { createMailTransport, mailConfigFromEnv } from '../../apps/worker/src/mail/index.js';
import { Metrics, silentLogger, Worker } from '../../apps/worker/src/index.js';
import { FakeMalwareScanner } from '../../apps/worker/src/files/scanner.js';
import { FilesystemBlobStore, TombstoneLedger } from '../../packages/data/src/files/index.js';
import { Client, TestClock, type Harness, type Response } from '../backend/helpers/app.js';
import { login, seedPersonas, type PersonaKey } from '../backend/helpers/personas.js';
import type { Seed } from '../data/helpers/seed.js';
import { endPool } from '../data/helpers/postgres.js';
import { provisionWorkerDatabase, type WorkerTestDatabase } from '../worker/helpers/worker-db.js';

export const ORIGIN = 'https://trustwork.test';
export const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
export const uploadKey = (): string => `k_${randomBytes(12).toString('hex')}`;

/** A minimal valid PNG (1x1) with a random comment (distinct bytes per call), optionally with extra chunks before IDAT. */
export function png(extraChunks: Uint8Array[] = []): Uint8Array {
  extraChunks = [pngChunk('tEXt', Buffer.from(`Comment\0${randomBytes(8).toString('hex')}`, 'latin1')), ...extraChunks];
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    Buffer.from(data).copy(out, 8);
    out.writeUInt32BE(0, 8 + data.length); // CRC is not checked by the inspection
    return out;
  };
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...extraChunks.map((c) => Buffer.from(c)),
    chunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01])), chunk('IEND', new Uint8Array()),
  ]);
}
export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  Buffer.from(data).copy(out, 8);
  return out;
}
/** A TIFF/EXIF block whose IFD0 has one entry; with `gps` that entry is a GPS IFD pointer to a one-entry GPS IFD. */
export function exifTiff(gps: boolean): Uint8Array {
  const b = Buffer.alloc(64);
  b.write('II', 0, 'latin1');
  b.writeUInt16LE(42, 2);
  b.writeUInt32LE(8, 4);
  b.writeUInt16LE(1, 8);
  b.writeUInt16LE(gps ? 0x8825 : 0x010f, 10); // GPSInfo pointer, or Make
  b.writeUInt16LE(gps ? 4 : 2, 12);
  b.writeUInt32LE(1, 14);
  b.writeUInt32LE(gps ? 26 : 0, 18);
  b.writeUInt32LE(0, 22);
  b.writeUInt16LE(1, 26); // GPS IFD: one entry (GPSLatitudeRef)
  b.writeUInt16LE(1, 28);
  return b;
}
/** A minimal JPEG: SOI, optional APP1 EXIF segment, SOS, EOI. */
export function jpeg(app1: Uint8Array | null = null): Uint8Array {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  if (app1) {
    const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from(app1)]);
    const head = Buffer.from([0xff, 0xe1, 0, 0]);
    head.writeUInt16BE(payload.length + 2, 2);
    parts.push(head, payload);
  }
  parts.push(Buffer.from([0xff, 0xdb, 0x00, 0x03, 0x00]), Buffer.from([0xff, 0xda, 0x00, 0x02]), Buffer.from([0x11, 0x22]), Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

export interface FilesStack {
  env: WorkerTestDatabase;
  admin: DataPool;
  app: CreatedApp;
  clock: TestClock;
  store: FilesystemBlobStore;
  tombstones: TombstoneLedger;
  scanner: FakeMalwareScanner;
  mandates: AllowListFileMandates;
  /** Mutable allow list behind `mandates`. */
  mandateGrants: { personId: string; mandateId: string; action: 'prepare' | 'record_evidence' | 'maintain_records' }[];
  seed: Seed;
  client(persona?: PersonaKey): Promise<Client>;
  worker(): Worker;
  /** Uploads through the API and the signed PUT, reports completion, and (by default) lets the worker scan it. */
  upload(client: Client, input: UploadInput, options?: { complete?: boolean; scan?: boolean; body?: Uint8Array }): Promise<{ id: string; start: Response; storageKey: string }>;
  drain(): Promise<void>;
  close(): Promise<void>;
}
export interface UploadInput {
  owner: { kind: 'person' | 'company'; id: string };
  parent: { kind: string; id: string };
  bytes: Uint8Array;
  mediaType?: string;
  classification?: string | null;
}

/** Real PostgreSQL (API and worker logins), the API with the filesystem storage fake, and the production worker registry. */
export async function startFilesStack(label: string): Promise<FilesStack | null> {
  const env = await provisionWorkerDatabase(label);
  if (!env) return null;
  const pools: DataPool[] = [env.db.teardown.watch(env.apiPool)];
  const root = mkdtempSync(join(tmpdir(), 'trustwork-files-test-'));
  const store = new FilesystemBlobStore({ root });
  const tombstones = new TombstoneLedger(new FilesystemBlobStore({ root, bucket: 'trustwork-tombstones' }));
  const scanner = new FakeMalwareScanner();
  const clock = new TestClock();
  const mandateGrants: FilesStack['mandateGrants'] = [];
  const mandates = new AllowListFileMandates(mandateGrants);
  const app = await createApp({
    env: { API_HOST: '127.0.0.1', API_PORT: '0', PUBLIC_ORIGIN: ORIGIN, AUTH_PROVIDER_MODE: 'fake', AUTH_RATE_LIMIT_PER_MINUTE: '10000', MAIL_SECRET_KEY: randomBytes(32).toString('hex') },
    pool: env.apiPool,
    clock,
    providers: { google: new FakeOidcProvider('google'), apple: new FakeOidcProvider('apple') },
    files: { store, mandates },
    logSink: (line) => {
      if (line.includes('"level":"error"')) console.error('[api]', line);
    },
  });
  const seed = await seedPersonas({ db: env.db } as unknown as Harness);
  const workers: Worker[] = [];
  const worker = (): Worker => {
    const pool = env.db.teardown.watch(env.workerPool(6));
    pools.push(pool);
    const mail = mailConfigFromEnv({ MAIL_TRANSPORT: 'fake', MAIL_SECRET_KEY: randomBytes(32).toString('hex'), MAIL_PUBLIC_ORIGIN: ORIGIN });
    const registry = buildRegistry({ pool, metrics: new Metrics(), log: silentLogger, mail, mailTransport: createMailTransport(mail), files: { store, tombstones, scanner } });
    const w = new Worker({ pool, registry, metrics: new Metrics(), config: { pollIntervalMs: 50, concurrency: 4 }, tasks: () => [], random: () => 0 });
    workers.push(w);
    return w;
  };
  let shared: Worker | null = null;
  const drain = async () => {
    shared ??= worker();
    let quiet = 0;
    for (let i = 0; i < 50 && quiet < 2; i += 1) {
      const report = await shared.runOnce({ rethrow: true });
      await shared.idle();
      quiet = report.relayed === 0 && report.leased === 0 ? quiet + 1 : 0;
    }
  };
  const stack: FilesStack = {
    env, admin: env.db.admin, app, clock, store, tombstones, scanner, mandates, mandateGrants, seed,
    async client(persona) {
      const c = new Client(app);
      if (persona) await login(c, persona);
      return c;
    },
    worker,
    drain,
    async upload(client, input, options = {}) {
      const body = options.body ?? input.bytes;
      const start = await client.post('/v1/files/uploads', {
        owner: input.owner, parent: input.parent, mediaType: input.mediaType ?? 'image/png', bytes: input.bytes.byteLength, sha256: sha(input.bytes), uploadKey: uploadKey(),
        ...(input.classification !== undefined ? { classification: input.classification } : {}),
      });
      if (start.status !== 201) throw new Error(`upload start failed: ${start.status} ${JSON.stringify(start.body)}`);
      const result = start.body as { file: { id: string }; upload: { url: string; headers: Record<string, string> } };
      await store.acceptPut(result.upload.url, body, { ...result.upload.headers, 'content-length': String(body.byteLength) }, clock.now());
      const key = decodeURIComponent(new URL(result.upload.url).pathname.slice(1));
      if (options.complete !== false) {
        const done = await client.post(`/v1/files/${result.file.id}/complete`, {});
        if (done.status !== 200) throw new Error(`complete failed: ${done.status} ${JSON.stringify(done.body)}`);
        if (options.scan !== false) await drain();
      }
      return { id: result.file.id, start, storageKey: key };
    },
    async close() {
      for (const w of workers) await w.stop(200).catch(() => undefined);
      await app.close();
      env.db.teardown.begin();
      await Promise.all(pools.map((pool) => endPool(pool).catch(() => undefined)));
      await env.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
  return stack;
}
