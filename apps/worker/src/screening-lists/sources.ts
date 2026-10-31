import { stat as fsStat, readFile as fsReadFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ScreeningListMode } from '../../../../packages/contracts/src/sanctions.js';
import { fakeListExport, sourceDigest, type ListAdapter } from '../../../../packages/compliance/src/lists/index.js';
import type { LockedScreeningList } from '../../../../packages/data/src/repositories/screening-lists.js';

/**
 * Where a list export comes from, one source per ingestion mode (ADR 014 decision 10):
 *
 * - `file`: the operator drops the official export into the lists directory (`<dir>/<code>.<ext>`, a hub's list under
 *   `<dir>/<hub id>/`); no network. The file's modification time is when the content was obtained, so re-reading an
 *   unchanged file never makes a list look fresher.
 * - `live`: downloads the list's source URL through a fetcher only when a provider activation by a second person
 *   exists (KEYS-001). Without both it refuses before any network call. This package ships no fetcher: KEYS-001 brings
 *   the egress-proxy fetcher and the activation lookup.
 * - `fake`: the synthetic list (`@trustwork/compliance` fake list) in the OFAC schema; refused in production.
 */
export interface ObtainedExport {
  readonly text: string;
  readonly sourceDigest: string;
  /** When the content was obtained from its authority (never later than now). */
  readonly obtainedAt: Date;
}

/** A source refused or could not deliver; nothing of the attempt is staged. */
export class ListSourceError extends Error {
  constructor(readonly outcome: 'source_missing' | 'refused' | 'failed', readonly code: string, message: string) {
    super(message);
    this.name = 'ListSourceError';
  }
}

export interface ListSource {
  readonly mode: ScreeningListMode;
  obtain(list: LockedScreeningList, adapter: ListAdapter, signal: AbortSignal): Promise<ObtainedExport>;
}

export interface FileSystemPort {
  stat(path: string): Promise<{ size: number; mtime: Date; isFile(): boolean }>;
  readFile(path: string): Promise<Buffer>;
}
const NODE_FS: FileSystemPort = { stat: (path) => fsStat(path), readFile: (path) => fsReadFile(path) };

const notLater = (time: Date, now: Date): Date => (time.getTime() > now.getTime() ? now : time);

/** The path of a list's export in `file` mode. */
export function listFilePath(dir: string, list: Pick<LockedScreeningList, 'hubId' | 'code'>, adapter: Pick<ListAdapter, 'extension'>): string {
  return list.hubId ? join(dir, list.hubId, `${list.code}.${adapter.extension}`) : join(dir, `${list.code}.${adapter.extension}`);
}

export function fileListSource(options: { dir: string | null; maxBytes: number; fs?: FileSystemPort; now?: () => Date }): ListSource {
  const fs = options.fs ?? NODE_FS;
  const now = options.now ?? (() => new Date());
  return {
    mode: 'file',
    async obtain(list, adapter) {
      if (!options.dir) throw new ListSourceError('source_missing', 'no_lists_directory', 'no lists directory is configured (SCREENING_LISTS_DIR or TRUSTWORK_DATA_DIR)');
      const path = listFilePath(options.dir, list, adapter);
      let info: Awaited<ReturnType<FileSystemPort['stat']>>;
      try {
        info = await fs.stat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ListSourceError('source_missing', 'file_missing', `no export file for ${list.code}`);
        throw new ListSourceError('failed', 'file_unreadable', `the export file for ${list.code} cannot be read`);
      }
      if (!info.isFile()) throw new ListSourceError('refused', 'not_a_file', `the export path for ${list.code} is not a file`);
      if (info.size > options.maxBytes) throw new ListSourceError('refused', 'too_large', `the export file for ${list.code} exceeds ${options.maxBytes} bytes`);
      const bytes = await fs.readFile(path);
      if (bytes.byteLength > options.maxBytes) throw new ListSourceError('refused', 'too_large', `the export file for ${list.code} exceeds ${options.maxBytes} bytes`);
      return { text: bytes.toString('utf8'), sourceDigest: sourceDigest(bytes), obtainedAt: notLater(info.mtime, now()) };
    },
  };
}

/** A provider activation for a live list (KEYS-001): two different people activated the connection. */
export interface LiveActivation {
  readonly connectionId: string;
  readonly activatedBy: string;
  readonly approvedBy: string;
}

/** Downloads through the hub's egress path (KEYS-001); never `globalThis.fetch` directly. */
export type ListFetcher = (url: string, options: { signal: AbortSignal; maxBytes: number }) => Promise<{ status: number; body: Uint8Array }>;

export function liveListSource(options: { fetcher: ListFetcher | null; activation: (list: LockedScreeningList) => Promise<LiveActivation | null> | LiveActivation | null; maxBytes: number; now?: () => Date }): ListSource {
  const now = options.now ?? (() => new Date());
  return {
    mode: 'live',
    async obtain(list, _adapter, signal) {
      const activation = await options.activation(list);
      if (!activation) throw new ListSourceError('refused', 'live_not_activated', `live ingestion of ${list.code} needs a provider activated by a second person (KEYS-001)`);
      if (!activation.activatedBy || activation.activatedBy === activation.approvedBy) throw new ListSourceError('refused', 'live_not_activated', `the live provider of ${list.code} was not approved by a second person`);
      if (!options.fetcher) throw new ListSourceError('refused', 'no_fetcher', 'no egress fetcher is configured for live lists');
      let response: { status: number; body: Uint8Array };
      try {
        response = await options.fetcher(list.sourceUrl, { signal, maxBytes: options.maxBytes });
      } catch (error) {
        throw new ListSourceError('failed', 'fetch_failed', `download of ${list.code} failed: ${error instanceof Error ? error.message.slice(0, 120) : 'error'}`);
      }
      if (response.status !== 200) throw new ListSourceError('failed', `http_${response.status}`, `download of ${list.code} answered ${response.status}`);
      if (response.body.byteLength > options.maxBytes) throw new ListSourceError('refused', 'too_large', `the download of ${list.code} exceeds ${options.maxBytes} bytes`);
      return { text: Buffer.from(response.body).toString('utf8'), sourceDigest: sourceDigest(response.body), obtainedAt: now() };
    },
  };
}

export function fakeListSource(options: { production: boolean; render?: (list: LockedScreeningList) => string; now?: () => Date }): ListSource {
  const now = options.now ?? (() => new Date());
  const render = options.render ?? (() => fakeListExport());
  return {
    mode: 'fake',
    async obtain(list) {
      if (options.production) throw new ListSourceError('refused', 'fake_in_production', 'fake lists are refused in production');
      const text = render(list);
      return { text, sourceDigest: sourceDigest(text), obtainedAt: now() };
    },
  };
}
