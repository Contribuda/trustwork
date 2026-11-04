import type { Principal } from '../../../deps/contracts.js';
import type { Transaction } from '../../../deps/data.js';
import { ApiError } from '../../../common/errors.js';
import type { RequestState } from '../../../common/request.js';
import type { PrincipalService } from '../../identity/principal.service.js';
import type { StaffTarget } from '../authority.js';
import { adminRefusal } from '../errors.js';
import type { Attempt, Elevated, LateAttempt, PlatformAdminService } from '../platform-admin.service.js';
import { scopeOf } from '../views.js';
import {
  consoleFlags, consoleNotifications, consoleReads, ConsoleSearchHitSchema, consoleViews, ConsoleViewConfigurationSchema, ConsoleWorkItemSchema, CONSOLE_WORK_LIMIT, parseConsoleRef,
  type ActiveFlags, type ConsoleFlag, type ConsoleFlagRow, type ConsoleNotificationSettingRow, type ConsoleNotificationSettings, type ConsoleSavedView, type ConsoleSavedViewRow, type ConsoleSearchResult,
  type ConsoleWorkCount, type ConsoleWorkList, type ConsoleWorkView, type CreateConsoleViewCommand, type RemoveConsoleViewCommand, type SetConsoleNotificationsCommand, type SetFlagStageCommand,
  type UpdateConsoleViewCommand,
} from './deps.js';
import { flagInForce } from './flag-buckets.js';

const iso = (value: Date | string): string => new Date(value).toISOString();

function toView(row: ConsoleSavedViewRow, me: string): ConsoleSavedView {
  return {
    id: row.id, scope: scopeOf(row), surface: row.surface as ConsoleSavedView['surface'], name: row.name, configuration: ConsoleViewConfigurationSchema.parse(row.configuration),
    teamRole: row.team_role as ConsoleSavedView['teamRole'], mine: row.owner_person_id === me, isDefault: row.is_default && row.owner_person_id === me, revision: row.revision, updatedAt: iso(row.updated_at),
  };
}

function toSettings(row: ConsoleNotificationSettingRow | undefined): ConsoleNotificationSettings {
  if (!row) return { emailCategories: [], quietHours: null, revision: 0 };
  return {
    emailCategories: row.email_categories as ConsoleNotificationSettings['emailCategories'],
    quietHours: row.quiet_from_minute === null || row.quiet_until_minute === null || row.quiet_time_zone === null ? null : { fromMinute: row.quiet_from_minute, untilMinute: row.quiet_until_minute, timeZone: row.quiet_time_zone },
    revision: row.revision,
  };
}

function toFlag(row: ConsoleFlagRow, now: Date): ConsoleFlag {
  return {
    id: row.id, key: row.key, scope: scopeOf(row), declaredEffect: row.declared_effect, stage: row.stage, sharePercent: row.share_percent as ConsoleFlag['sharePercent'], expiresAt: iso(row.expires_at),
    expired: new Date(row.expires_at).getTime() <= now.getTime(), revision: row.rollout_revision,
  };
}

/**
 * Console navigation services (ADM-005): the object lookup, the work list, saved views, notification settings and the
 * rollout stage of a flag. Reads run as the staff member; `console_search` and `console_work_items` decide what is found
 * in the database, and this class only shapes it. Every hit and item goes through its strict schema on the way out, so a
 * field added to the SQL by mistake fails instead of reaching a reader.
 *
 * A reader who is not staff at the target gets the same empty answer as a reader with nothing to see: the routes never
 * tell a person that a hub, an object or a list exists. Commands use the staff plumbing of `PlatformAdminService`.
 */
export class ConsoleServicesService {
  constructor(private readonly ctx: { clock: { now(): Date } }, private readonly principals: PrincipalService, private readonly admin: PlatformAdminService, private readonly servedHubId: string | null) {}

  private read<T>(state: RequestState, fn: (trx: Transaction, p: Principal) => Promise<T>): Promise<T> {
    return this.principals.runAs(state, fn).catch((error: unknown) => {
      throw adminRefusal(error) ?? error;
    });
  }

  /* ---------- Lookup ---------- */

  search(state: RequestState, ref: string, target: StaffTarget): Promise<ConsoleSearchResult> {
    const parsed = parseConsoleRef(ref);
    if (!parsed) throw new ApiError('validation.schema', 'an object id, a number or a flag key');
    const input = parsed.kind === 'id' ? { id: parsed.id } : parsed.kind === 'number' ? { number: parsed.number } : { key: parsed.key };
    return this.read(state, async (trx) => ({ hits: (await consoleReads.search(trx, input, target)).map((hit) => ConsoleSearchHitSchema.parse(hit)) }));
  }

  /* ---------- Work items ---------- */

  work(state: RequestState, view: ConsoleWorkView, target: StaffTarget): Promise<ConsoleWorkList> {
    return this.read(state, async (trx) => {
      const rows = await consoleReads.workItems(trx, view, target);
      return { view, items: rows.slice(0, CONSOLE_WORK_LIMIT).map((item) => ConsoleWorkItemSchema.parse(item)), truncated: rows.length > CONSOLE_WORK_LIMIT };
    });
  }

  /** The band's count: the rows of "Waiting for me" themselves, so it can never count what the list would not show. */
  workCount(state: RequestState, target: StaffTarget): Promise<ConsoleWorkCount> {
    return this.read(state, async (trx) => {
      const rows = await consoleReads.workItems(trx, 'waiting', target);
      return { waiting: Math.min(rows.length, CONSOLE_WORK_LIMIT), truncated: rows.length > CONSOLE_WORK_LIMIT };
    });
  }

  /* ---------- Saved views ---------- */

  views(state: RequestState, target: StaffTarget, surface: string | undefined): Promise<{ views: ConsoleSavedView[] }> {
    return this.read(state, async (trx, p) => ({ views: (await consoleViews.list(trx, target, surface)).map((row) => toView(row, p.personId)) }));
  }

  createView(e: Elevated, body: CreateConsoleViewCommand) {
    const attempt: Attempt = { target: body.scope, permission: 'admin.session.elevate', action: 'console.view_created', objectType: 'console_saved_view', objectId: e.elevationId };
    return this.admin.staffCommand(e, body, attempt, async (trx, p, cmd) => ({
      view: toView(await consoleViews.create(trx, cmd, { scope: body.scope, surface: body.surface, name: body.name, configuration: body.configuration, teamRole: body.teamRole, isDefault: body.isDefault }), p.personId),
    }));
  }

  updateView(e: Elevated, id: string, body: UpdateConsoleViewCommand) {
    return this.admin.staffCommand(e, body, null, async (trx, p, cmd) => ({
      view: toView(await consoleViews.update(trx, cmd, id, { expectedRevision: body.expectedRevision, name: body.name, configuration: body.configuration, teamRole: body.teamRole, isDefault: body.isDefault }), p.personId),
    }));
  }

  removeView(e: Elevated, id: string, body: RemoveConsoleViewCommand) {
    return this.admin.staffCommand(e, body, null, async (trx, _p, cmd) => {
      const row = await consoleViews.remove(trx, cmd, id, body.expectedRevision);
      return { removed: { id: row.id } };
    });
  }

  /* ---------- Notification settings ---------- */

  notifications(state: RequestState): Promise<ConsoleNotificationSettings> {
    return this.read(state, async (trx) => toSettings(await consoleNotifications.get(trx)));
  }

  setNotifications(e: Elevated, body: SetConsoleNotificationsCommand) {
    return this.admin.staffCommand(e, body, null, async (trx, _p, cmd) => toSettings(await consoleNotifications.set(trx, cmd, { scope: body.scope, expectedRevision: body.expectedRevision, emailCategories: body.emailCategories, quietHours: body.quietHours })));
  }

  /* ---------- Flag rollout ---------- */

  flags(state: RequestState, target: StaffTarget): Promise<{ flags: ConsoleFlag[] }> {
    return this.read(state, async (trx) => {
      if (!(await consoleReads.isStaff(trx, target))) return { flags: [] };
      const now = this.ctx.clock.now();
      return { flags: (await consoleFlags.list(trx, target)).map((row) => toFlag(row, now)) };
    });
  }

  /** A refusal is audited at the flag's own scope, known only by reading it. */
  setFlagStage(e: Elevated, id: string, body: SetFlagStageCommand) {
    const attempt: LateAttempt = async (trx) => {
      const flag = await consoleFlags.one(trx, id);
      return flag ? { target: scopeOf(flag), permission: 'admin.flags.edit', action: `flags.stage_${body.stage}`, objectType: 'feature_flag', objectId: id } : null;
    };
    return this.admin.staffCommand(e, body, attempt, async (trx, _p, cmd) => {
      await consoleFlags.setStage(trx, cmd, { flagId: id, stage: body.stage, sharePercent: body.sharePercent, expectedRevision: body.expectedRevision });
      const flag = await consoleFlags.one(trx, id);
      if (!flag) throw new ApiError('access.not_found', 'flag not found');
      return { flag: toFlag(flag, this.ctx.clock.now()) };
    });
  }

  /**
   * The flags in force for this session at the hub this API serves, read fresh on every call: there is no cache to outlive
   * turning a flag off. Flags that are not in force for this session are not named, and no other hub's are reachable.
   * Being staff of another hub counts for nothing here. A deployment that serves no hub has no flags in force.
   */
  activeFlags(state: RequestState): Promise<ActiveFlags> {
    const session = state.session;
    if (!session) throw new ApiError('auth.session_invalid', 'authentication required');
    const hubId = this.servedHubId;
    if (!hubId) return Promise.resolve({ flags: [] });
    return this.read(state, async (trx) => {
      const staff = await consoleReads.isStaff(trx, { kind: 'hub', hubId });
      const rows = await consoleFlags.inForceAt(trx, hubId);
      return { flags: rows.filter((row) => flagInForce({ id: row.id, stage: row.stage, sharePercent: row.share_percent }, { id: session.id, staff })).map((row) => ({ key: row.key, value: row.value })) };
    });
  }
}
