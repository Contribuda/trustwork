/**
 * Row shapes of the ADM-004 staff-lifecycle reads (migration packages/data/migrations/staff-lifecycle). Part 1 adds no
 * table: the directory is a SECURITY DEFINER read over staff assignments, people and second factors.
 */

/** One row of `trustwork.staff_directory(hub)`; `roles` and `second_factor` are null without `admin.staff.read`. */
export interface StaffDirectoryRow {
  person_id: string;
  display_name: string;
  detail: boolean;
  roles: Array<{ assignmentId: string; role: string; scope: { kind: 'platform' } | { kind: 'node'; nodeId: string } | { kind: 'hub'; hubId: string }; validUntil: string | null; breakglass: boolean }> | null;
  second_factor: 'enrolled' | 'none' | null;
}

/** Part 1 adds no table (checked against the migrations by tests/data/migrations.test.ts). */
export const TABLE_COLUMNS: Record<string, readonly string[]> = {};
