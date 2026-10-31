import type pg from 'pg';
import type { PgExec } from '../../infra/backup/src/pg.js';

/**
 * Restore fence (OPS-003): until reconciliation is finished and an operator authorizes, no runtime login (members of
 * trustwork_worker and trustwork_app) can connect to a restored database. A worker that cannot connect leases no job
 * and therefore contacts no provider; an API that cannot connect serves nothing. Two implementations:
 *
 *   HbaFence   reject rules at the top of the restored cluster's pg_hba.conf, written into the data directory BEFORE
 *              the server first starts (no window in which a runtime login could connect), matched by group
 *              membership (+trustwork_worker, +trustwork_app) so it covers every runtime login of the cluster;
 *   RoleFence  ALTER ROLE ... NOLOGIN for named logins and termination of their sessions, for clusters whose
 *              configuration files the operator cannot edit (managed services) and for tests on a shared cluster.
 *
 * The operator's own login (superuser or migrator) stays usable for verification and reconciliation.
 */
export interface RestoreFence {
  readonly kind: 'hba' | 'role';
  apply(): Promise<void>;
  lift(): Promise<void>;
  isApplied(): Promise<boolean>;
  describe(): string;
}

export const FENCE_BEGIN = '# trustwork-restore-fence begin';
export const FENCE_END = '# trustwork-restore-fence end';
export const FENCED_GROUPS = ['trustwork_worker', 'trustwork_app'] as const;

/** The pg_hba.conf block; first matching rule wins, so it is placed before every other rule. */
export function hbaFenceBlock(groups: readonly string[] = FENCED_GROUPS): string {
  const lines = [FENCE_BEGIN, '# Written by scripts/restore (OPS-003): runtime logins stay out until the restore is reconciled and authorized.'];
  for (const group of groups) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(group)) throw new Error(`invalid group name ${group}`);
    lines.push(`local all +${group} reject`, `host all +${group} all reject`, `hostssl all +${group} all reject`, `hostnossl all +${group} all reject`);
  }
  lines.push(FENCE_END);
  return `${lines.join('\n')}\n`;
}

/** Removes the fence block from a pg_hba.conf text (pure; used by tests and by HbaFence.lift). */
export function withoutHbaFence(conf: string): string {
  const begin = conf.indexOf(FENCE_BEGIN);
  if (begin < 0) return conf;
  const end = conf.indexOf(FENCE_END, begin);
  if (end < 0) throw new Error('pg_hba.conf has a fence start without an end; fix it by hand');
  return conf.slice(0, begin) + conf.slice(end + FENCE_END.length).replace(/^\n/, '');
}

/**
 * pg_hba fence of a cluster reached through `exec` (running as the postgres OS user inside the database container).
 * `apply` is normally done by the staging step before the first start; this class can also apply it to a running
 * cluster (followed by a reload).
 */
export class HbaFence implements RestoreFence {
  readonly kind = 'hba' as const;
  constructor(private readonly exec: PgExec, private readonly hbaPath = '/var/lib/postgresql/18/docker/pg_hba.conf') {
    if (!/^\/[A-Za-z0-9/_.-]+$/.test(hbaPath) || hbaPath.includes('..')) throw new Error('invalid pg_hba.conf path');
  }
  private async read(): Promise<string> {
    return (await this.exec.run(['cat', this.hbaPath])).toString('utf8');
  }
  private async write(conf: string): Promise<void> {
    // Write next to the file and rename (atomic for the server's reload); keeps ownership of the postgres user.
    await this.exec.run(['sh', '-c', 'cat > "$1.fence-tmp" && chmod 600 "$1.fence-tmp" && mv "$1.fence-tmp" "$1"', 'sh', this.hbaPath], conf);
    await this.exec.psql('SELECT pg_reload_conf()', 'postgres');
  }
  async apply(): Promise<void> {
    const conf = await this.read();
    if (!conf.includes(FENCE_BEGIN)) await this.write(hbaFenceBlock() + conf);
  }
  async lift(): Promise<void> {
    const conf = await this.read();
    if (conf.includes(FENCE_BEGIN)) await this.write(withoutHbaFence(conf));
  }
  async isApplied(): Promise<boolean> {
    return (await this.read()).includes(FENCE_BEGIN);
  }
  describe(): string {
    return `pg_hba.conf reject rules for ${FENCED_GROUPS.map((g) => `+${g}`).join(', ')}`;
  }
}

/** NOLOGIN fence for named logins (the admin connection needs CREATEROLE or superuser). */
export class RoleFence implements RestoreFence {
  readonly kind = 'role' as const;
  constructor(private readonly admin: Pick<pg.Pool, 'query'>, private readonly logins: string[]) {
    for (const login of logins) if (!/^[a-z_][a-z0-9_]{0,62}$/.test(login)) throw new Error(`invalid login name ${login}`);
    if (!logins.length) throw new Error('a role fence needs at least one login');
  }
  /** Runtime logins of a cluster: members (direct or indirect) of trustwork_worker or trustwork_app that can log in. */
  static async discover(admin: Pick<pg.Pool, 'query'>): Promise<string[]> {
    const { rows } = await admin.query<{ rolname: string }>(`
      SELECT DISTINCT r.rolname FROM pg_roles r
      WHERE r.rolcanlogin AND NOT r.rolsuper AND (pg_has_role(r.oid, 'trustwork_worker', 'MEMBER') OR pg_has_role(r.oid, 'trustwork_app', 'MEMBER'))
      ORDER BY 1`);
    return rows.map((r) => r.rolname);
  }
  async apply(): Promise<void> {
    for (const login of this.logins) {
      await this.admin.query(`ALTER ROLE "${login}" NOLOGIN`);
      await this.admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1', [login]);
    }
  }
  async lift(): Promise<void> {
    for (const login of this.logins) await this.admin.query(`ALTER ROLE "${login}" LOGIN`);
  }
  async isApplied(): Promise<boolean> {
    const { rows } = await this.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ANY ($1) AND NOT rolcanlogin', [this.logins]);
    return (rows[0]?.n ?? 0) === this.logins.length;
  }
  describe(): string {
    return `NOLOGIN for ${this.logins.join(', ')}`;
  }
}
