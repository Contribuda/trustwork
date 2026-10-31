import { spawn } from 'node:child_process';

/**
 * Runs the PostgreSQL client tools (pg_basebackup, pg_dump, psql) and the WAL spool commands next to the database
 * (OPS-003). The command prefix says how to get there: for the compose stack it is
 * `docker compose -p <project> -f infra/compose.yaml -f infra/backup/compose.backup.yaml exec -T postgres`, so the
 * host needs no PostgreSQL tools and no published replication port; for a host with the tools installed it is empty.
 * Arguments are passed as an argv array (never through a shell), so names and paths are not interpreted.
 */
export class PgExecError extends Error {
  constructor(message: string, readonly code: number | null, readonly stderr: string) {
    super(message);
    this.name = 'PgExecError';
  }
}

export interface PgExecOptions {
  /** Command prefix, for example ['docker', 'compose', '-p', 'trustwork-local', ..., 'exec', '-T', 'postgres']. */
  prefix: string[];
  /** Role the tools connect as over the local socket: a superuser or a role with REPLICATION for base backups. */
  user: string;
  /** Database of logical dumps and SQL. */
  database: string;
  /** Spool directory of archive_command (infra/backup/compose.backup.yaml). */
  walSpool: string;
}

export interface PgExecEnv {
  BACKUP_PG_EXEC?: string | undefined;
  BACKUP_PG_USER?: string | undefined;
  BACKUP_PG_DATABASE?: string | undefined;
  BACKUP_WAL_SPOOL?: string | undefined;
}

export const DEFAULT_WAL_SPOOL = '/var/lib/postgresql/wal-spool';
const SEGMENT = /^[0-9A-F]{24}(\.partial)?$/;
const HISTORY = /^[0-9A-F]{8}\.history$/;

/** BACKUP_PG_EXEC is a JSON array of argv strings (spaces inside arguments survive) or a space-separated string. */
export function pgExecFromEnv(env: PgExecEnv, defaults: Partial<PgExecOptions> = {}): PgExec {
  const raw = env.BACKUP_PG_EXEC?.trim();
  let prefix = defaults.prefix ?? [];
  if (raw) {
    prefix = raw.startsWith('[') ? (JSON.parse(raw) as unknown[]).map(String) : raw.split(/\s+/);
  }
  return new PgExec({
    prefix,
    user: env.BACKUP_PG_USER?.trim() || defaults.user || 'trustwork_dev',
    database: env.BACKUP_PG_DATABASE?.trim() || defaults.database || 'trustwork_stack',
    walSpool: env.BACKUP_WAL_SPOOL?.trim() || defaults.walSpool || DEFAULT_WAL_SPOOL,
  });
}

export function composeExecPrefix(project: string, files: string[], service = 'postgres'): string[] {
  return ['docker', 'compose', '-p', project, ...files.flatMap((f) => ['-f', f]), 'exec', '-T', service];
}

export class PgExec {
  constructor(readonly options: PgExecOptions) {
    if (!/^[A-Za-z0-9_]{1,63}$/.test(options.user)) throw new PgExecError('invalid PostgreSQL user name', null, '');
    if (!/^[A-Za-z0-9_]{1,63}$/.test(options.database)) throw new PgExecError('invalid PostgreSQL database name', null, '');
    if (!/^\/[A-Za-z0-9/_.-]+$/.test(options.walSpool) || options.walSpool.includes('..')) throw new PgExecError('invalid WAL spool path', null, '');
  }

  private spawn(argv: string[]) {
    const [command, ...args] = [...this.options.prefix, ...argv];
    return spawn(command as string, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  }

  /** Runs to completion and returns stdout; throws PgExecError with the tail of stderr on a non-zero exit. */
  async run(argv: string[], input?: string | Uint8Array): Promise<Buffer> {
    const child = this.spawn(argv);
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => { err = (err + chunk.toString()).slice(-4000); });
    const done = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    child.stdin.end(input ?? '');
    const code = await done;
    if (code !== 0) throw new PgExecError(`${argv[0]} exited with ${code}: ${err.trim().slice(-500)}`, code, err);
    return Buffer.concat(out);
  }

  /**
   * Streams stdout in parts of `partBytes` and awaits `onPart` for each before reading on (backpressure: the child
   * blocks while a part is uploaded). Returns the number of parts; throws when the command fails.
   */
  async streamParts(argv: string[], partBytes: number, onPart: (part: Buffer, index: number) => Promise<void>): Promise<number> {
    const child = this.spawn(argv);
    child.stdin.end();
    let err = '';
    child.stderr.on('data', (chunk: Buffer) => { err = (err + chunk.toString()).slice(-4000); });
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let index = 0;
    const flush = async (all: boolean) => {
      while (pendingBytes >= partBytes || (all && pendingBytes > 0)) {
        const joined = Buffer.concat(pending);
        const part = joined.subarray(0, Math.min(partBytes, joined.length));
        const rest = joined.subarray(part.length);
        pending = rest.length ? [rest] : [];
        pendingBytes = rest.length;
        await onPart(Buffer.from(part), index++);
      }
    };
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      pending.push(chunk);
      pendingBytes += chunk.length;
      if (pendingBytes >= partBytes) await flush(false);
    }
    const code = await closed;
    if (code !== 0) throw new PgExecError(`${argv[0]} exited with ${code}: ${err.trim().slice(-500)}`, code, err);
    await flush(true);
    return index;
  }

  /** psql as the configured user; returns trimmed stdout of an unaligned, tuples-only run. */
  async psql(sql: string, database = this.options.database): Promise<string> {
    const out = await this.run(['psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-U', this.options.user, '-d', database, '-f', '-'], sql);
    return out.toString('utf8').trim();
  }

  /** WAL files waiting in the spool (completed segments and timeline history files), oldest first. */
  async spooled(): Promise<string[]> {
    const out = await this.run(['sh', '-c', 'ls -1 "$1" 2>/dev/null || true', 'sh', this.options.walSpool]);
    return out.toString('utf8').split('\n').map((s) => s.trim()).filter((name) => SEGMENT.test(name) || HISTORY.test(name)).sort();
  }

  async readSpooled(name: string): Promise<Buffer> {
    assertWalName(name);
    return this.run(['cat', `${this.options.walSpool}/${name}`]);
  }

  async removeSpooled(name: string): Promise<void> {
    assertWalName(name);
    await this.run(['rm', '-f', `${this.options.walSpool}/${name}`]);
  }
}

export function assertWalName(name: string): void {
  if (!SEGMENT.test(name) && !HISTORY.test(name)) throw new PgExecError(`not a WAL file name: ${name}`, null, '');
}
