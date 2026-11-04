import type { ColumnType, Generated, Selectable } from 'kysely';
import { columnsOf, type TableColumns } from './index.js';

/**
 * Tables of ADM-005 (packages/data/migrations/console-services): the rollout stage of a feature flag, saved views and a
 * staff member's notification settings. Staff writes go only through the SECURITY DEFINER commands wrapped by
 * `repositories/console-services.ts`; the runtime role reads under FORCE row-level security.
 */
export type FlagStage = 'off' | 'staff_only' | 'share' | 'on';

export interface FeatureFlagRolloutTable {
  flag_id: string;
  stage: Generated<FlagStage>;
  share_percent: number | null;
  revision: Generated<number>;
  updated_at: Generated<Date>;
}
export type FeatureFlagRolloutRow = Selectable<FeatureFlagRolloutTable>;

export interface ConsoleSavedViewTable {
  id: Generated<string>;
  scope_kind: 'platform' | 'node' | 'hub';
  node_id: string | null;
  hub_id: string | null;
  surface: string;
  owner_person_id: string;
  team_role: string | null;
  name: string;
  configuration: ColumnType<unknown, string, string>;
  is_default: Generated<boolean>;
  removed_at: Date | null;
  revision: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export type ConsoleSavedViewRow = Selectable<ConsoleSavedViewTable>;

export interface ConsoleNotificationSettingTable {
  person_id: string;
  email_categories: Generated<string[]>;
  quiet_from_minute: number | null;
  quiet_until_minute: number | null;
  quiet_time_zone: string | null;
  revision: Generated<number>;
  updated_at: Generated<Date>;
}
export type ConsoleNotificationSettingRow = Selectable<ConsoleNotificationSettingTable>;

export interface ConsoleServicesDatabase {
  feature_flag_rollout: FeatureFlagRolloutTable;
  console_saved_view: ConsoleSavedViewTable;
  console_notification_setting: ConsoleNotificationSettingTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends ConsoleServicesDatabase {}
}

const columns = columnsOf<ConsoleServicesDatabase>();
export const TABLE_COLUMNS: TableColumns<ConsoleServicesDatabase> = {
  feature_flag_rollout: columns('feature_flag_rollout', ['flag_id', 'stage', 'share_percent', 'revision', 'updated_at']),
  console_saved_view: columns('console_saved_view', [
    'id', 'scope_kind', 'node_id', 'hub_id', 'surface', 'owner_person_id', 'team_role', 'name', 'configuration', 'is_default', 'removed_at', 'revision', 'created_at', 'updated_at',
  ]),
  console_notification_setting: columns('console_notification_setting', ['person_id', 'email_categories', 'quiet_from_minute', 'quiet_until_minute', 'quiet_time_zone', 'revision', 'updated_at']),
};
