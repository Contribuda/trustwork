import type { ReactNode } from 'react';
import { suppressSmallCount, type ConsolePermission } from '@trustwork/contracts/client';
import { Button } from '@/components/ui';
import { t } from '@/app/_lib/i18n';
import type { CommandState } from '../../../_data/command-state';
import { ConsoleForm } from '../../../_components/ConsoleForm';
import type { HubContext } from '../../../_components/context';
import { formLabels, readOnlyReason } from '../../../_components/forms';
import { number } from '../../../_components/format';

/**
 * Rendering parts shared by HUBC-004's console groups (participants, support, trust and safety): section forms with
 * their hidden fields, suppressed cohort counts, state pills and tables that become labelled cards on a phone.
 * Commands and their runner are in `_section-command.ts`.
 */

/** Hidden fields of a section form: the command, this hub, its revision and, in demo mode, the persona and scenario. */
export function hiddenFor(ctx: HubContext, command: string, fields: Record<string, string> = {}): Record<string, string> {
  const extra: Record<string, string> = {};
  for (const [name, value] of Object.entries(fields)) extra[`f.${name}`] = value;
  return {
    command,
    hub: ctx.record.hub.slug,
    expectedRevision: String(ctx.record.hub.revision),
    ...(ctx.request.demo && ctx.request.persona ? { persona: ctx.request.persona } : {}),
    ...(ctx.request.demo && ctx.request.scenario !== 'default' ? { scenario: ctx.request.scenario } : {}),
    ...extra,
  };
}

/** Whether this request reads synthetic fixtures (demo mode). Live mode has no participants backend in the console yet. */
export function fixturesOn(ctx: HubContext): boolean {
  return ctx.port.source === 'fixtures';
}

/** A section form: the console's mutation form with the group's server action, a required reason and the audit note. */
export function SectionForm({
  ctx,
  action,
  command,
  fields,
  submit,
  can,
  secondPerson = false,
  blocked,
  variant,
  children,
}: {
  ctx: HubContext;
  action: (previous: CommandState, form: FormData) => Promise<CommandState>;
  command: string;
  fields?: Record<string, string>;
  submit: string;
  /** The viewer holds one of these permissions (otherwise read-only with the explanation). */
  can: readonly ConsolePermission[];
  secondPerson?: boolean;
  /** A reason the action cannot be taken on this object (shown instead of enabling the form). */
  blocked?: string | null;
  variant?: 'primary' | 'secondary' | 'danger';
  children?: ReactNode;
}) {
  const disabled = readOnlyReason(can.some((p) => ctx.can(p)), ctx.offline) ?? blocked ?? null;
  return (
    <ConsoleForm action={action} hidden={hiddenFor(ctx, command, fields)} labels={formLabels({ submit, secondPerson })} disabledReason={disabled} submitVariant={variant}>
      {children}
    </ConsoleForm>
  );
}

/** A participant cohort count: below ten it is never shown (`AGGREGATE_MIN_COHORT`), only "fewer than 10". */
export function Count({ value }: { value: number }) {
  const shown = suppressSmallCount(value);
  return shown === null ? <span className="admin-meta" data-suppressed="true">{t('adminParticipants.common.suppressed')}</span> : <span>{number(shown)}</span>;
}

/** A state as text in a pill (never colour alone). */
export function Pill({ tone, children }: { tone: 'pass' | 'warn' | 'fail' | 'neutral'; children: ReactNode }) {
  return <span className={`admin-pill${tone === 'neutral' ? '' : ` admin-pill--${tone}`}`}>{children}</span>;
}

export type Column<T> = { label: string; render: (row: T) => ReactNode; lang?: (row: T) => string | undefined };

/** A data table with `data-label` cells, so rows become labelled cards below 1024 px (admin.css). */
export function Table<T>({ caption, rows, columns, rowKey, testid, empty }: { caption?: string; rows: readonly T[]; columns: ReadonlyArray<Column<T>>; rowKey: (row: T) => string; testid?: string; empty: string }) {
  if (!rows.length) return <p className="admin-empty">{empty}</p>;
  return (
    <table className="plain-table" {...(testid ? { 'data-testid': testid } : {})}>
      {caption ? <caption className="admin-visually-hidden">{caption}</caption> : null}
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.label} scope="col">
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={rowKey(row)} data-row={rowKey(row)}>
            {columns.map((c) => {
              const lang = c.lang?.(row);
              return (
                <td key={c.label} data-label={c.label} {...(lang ? { lang } : {})}>
                  {c.render(row)}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Text written by people (staff notes, statements, synthetic names) keeps its own language. */
export function Lang({ text }: { text: { value: string; lang: string } }) {
  return <span lang={text.lang}>{text.value}</span>;
}

export const en = (value: string) => ({ value, lang: 'en' });

/** Counts as tiles (label above, value below), for cohorts and operational totals. */
export function Tiles({ items, testid }: { items: ReadonlyArray<{ key: string; label: string; value: ReactNode }>; testid?: string }) {
  return (
    <ul className="admin-tiles" {...(testid ? { 'data-testid': testid } : {})}>
      {items.map((item) => (
        <li key={item.key} className="admin-tile admin-tile--unknown">
          <span className="admin-tile__label">{item.label}</span>
          <span className="admin-tile__state">{item.value}</span>
        </li>
      ))}
    </ul>
  );
}

export type StaffNames = ReadonlyMap<string, { text: string; lang: string }>;

/** Display names of staff members referenced by a screen (deciders, requesters, assignees). */
export async function staffNames(ctx: HubContext, ids: ReadonlyArray<string | null | undefined>): Promise<StaffNames> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  const people = await ctx.port.people(wanted);
  return new Map(people.map((p) => [p.id, { text: p.displayName, lang: p.nameLang }]));
}

export function StaffName({ names, id }: { names: StaffNames; id: string | null }) {
  if (!id) return <span className="admin-meta">{t('admin.common.none')}</span>;
  const name = names.get(id);
  return name ? <span lang={name.lang}>{name.text}</span> : <span>{t('admin.common.unknownPerson')}</span>;
}

/** A labelled checkbox whose value reaches the command as `on` (evidence recorded, and similar confirmations). */
export function CheckField({ name, label }: { name: string; label: string }) {
  const id = `field-${name.replace(/[^a-zA-Z0-9]/g, '-')}`;
  return (
    <label className="admin-check-input" htmlFor={id}>
      <input id={id} type="checkbox" name={`f.${name}`} />
      <span>{label}</span>
    </label>
  );
}

/**
 * A search form that reads with GET (lookups, the access explainer): the demo persona and scenario ride along as
 * hidden fields, so the result renders for the same demo viewer; live mode adds nothing.
 */
export function GetForm({ ctx, path, submit, children, id }: { ctx: HubContext; path: string; submit: string; children: ReactNode; id: string }) {
  const action = ctx.href(path).split('?')[0] ?? '';
  return (
    <form method="get" action={action} className="admin-form" id={id}>
      {ctx.request.demo && ctx.request.persona ? <input type="hidden" name="persona" value={ctx.request.persona} /> : null}
      {ctx.request.demo && ctx.request.scenario !== 'default' ? <input type="hidden" name="scenario" value={ctx.request.scenario} /> : null}
      <div className="admin-form__fields admin-form__grid">{children}</div>
      <div className="admin-form__actions">
        <Button type="submit" variant="secondary">
          {submit}
        </Button>
      </div>
    </form>
  );
}
