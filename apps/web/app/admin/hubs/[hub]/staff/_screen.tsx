import { SENSITIVE_HUB_STAFF_ROLES } from '@trustwork/contracts/client';
import { t, tDynamic } from '@/app/_lib/i18n';
import NextLink from '@/components/locale/LocalLink';
import { submitConsoleCommand } from '../../../_data/actions';
import { ConsoleForm } from '../../../_components/ConsoleForm';
import type { HubContext } from '../../../_components/context';
import type { Screen, ScreenRoute } from '../../../_components/screen';
import { formLabels, readOnlyReason, SelectField } from '../../../_components/forms';
import { dateTime } from '../../../_components/format';
import { ConsoleHeader, KeyValues, Panel, roleList } from '../../../_components/shell';
import type { StaffDirectoryEntry, StaffDirectoryRole } from '../../../../../../../packages/contracts/src/staff-lifecycle.js';

const UUIDISH = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function scopeLabel(role: StaffDirectoryRole, hubId: string): string {
  if (role.scope.kind === 'hub') return role.scope.hubId === hubId ? t('admin.staff.scope.thisHub') : t('admin.staff.scope.otherHub');
  return t(`admin.staff.scope.${role.scope.kind}`);
}

function RoleRow({ ctx, role }: { ctx: HubContext; role: StaffDirectoryRole }) {
  const zone = ctx.record.hub.timeZone;
  const here = role.scope.kind === 'hub' && role.scope.hubId === ctx.record.hub.id;
  return (
    <li className="admin-staff__role" data-testid={`staff-role-${role.assignmentId}`}>
      <span>
        <strong>{tDynamic(`admin.roles.${role.role}`, role.role)}</strong> · {scopeLabel(role, ctx.record.hub.id)}
        {role.validUntil ? <> · {t('admin.staff.until', { date: dateTime(role.validUntil, zone) })}</> : null}
        {role.breakglass ? <> · <span className="admin-warning">{t('admin.staff.breakglass')}</span></> : null}
      </span>
      {here ? (
        <details className="admin-staff__revoke">
          <summary>{t('admin.staff.revoke')}</summary>
          <ConsoleForm
            action={submitConsoleCommand}
            hidden={ctx.hidden('staff.revoke', { 'f.assignmentId': role.assignmentId })}
            labels={formLabels({ submit: t('admin.staff.revokeSubmit') })}
            disabledReason={readOnlyReason(ctx.can('admin.staff.revoke'), ctx.offline)}
          />
        </details>
      ) : (
        <span className="admin-meta"> · {t('admin.staff.managedAtNode')}</span>
      )}
    </li>
  );
}

/** A person's name is data in their own language, which the directory does not record ("undetermined" on the live API). */
const nameLang = (ctx: HubContext) => (ctx.request.demo ? 'en' : 'und');

function PersonRow({ ctx, entry, selected }: { ctx: HubContext; entry: StaffDirectoryEntry; selected: boolean }) {
  return (
    <tr data-testid={`staff-${entry.personId}`} aria-current={selected || undefined}>
      <th scope="row" data-label={t('admin.staff.name')}>
        <NextLink href={ctx.href('staff', { person: entry.personId })}>
          <span lang={nameLang(ctx)}>{entry.displayName}</span>
        </NextLink>
        {entry.personId === ctx.viewer.person.id ? <span className="admin-meta"> · {t('admin.common.you')}</span> : null}
      </th>
      <td data-label={t('admin.staff.roles')}>
        {entry.roles ? (
          <ul className="admin-staff__roles">
            {entry.roles.map((r) => (
              <RoleRow key={r.assignmentId} ctx={ctx} role={r} />
            ))}
          </ul>
        ) : (
          <span className="admin-meta">{t('admin.staff.rolesHidden')}</span>
        )}
      </td>
      <td data-label={t('admin.staff.secondFactor')}>
        {entry.secondFactor === 'enrolled' ? t('admin.staff.enrolled') : entry.secondFactor === 'none' ? <span className="admin-warning">{t('admin.staff.notEnrolled')}</span> : '—'}
      </td>
    </tr>
  );
}

async function Access({ ctx, entry }: { ctx: HubContext; entry: StaffDirectoryEntry }) {
  const access = await ctx.port.effectiveAccess(ctx.record.hub.id, entry.personId);
  return (
    <Panel id="access" title={t('admin.staff.accessFor')}>
      {access ? (
        <>
          <KeyValues
            rows={[
              { label: t('admin.staff.name'), value: entry.displayName, lang: nameLang(ctx) },
              { label: t('admin.staff.roles'), value: roleList(access.roles) },
              { label: t('admin.staff.permissionCount'), value: String(access.permissions.length) },
            ]}
          />
          <details>
            <summary>{t('admin.staff.permissions')}</summary>
            <ul className="admin-staff__permissions">
              {access.permissions.map((p) => (
                <li key={p}>
                  <code className="admin-code">{p}</code>
                </li>
              ))}
            </ul>
          </details>
        </>
      ) : (
        <p className="admin-empty">{t('admin.staff.accessUnavailable')}</p>
      )}
    </Panel>
  );
}

async function Staff(ctx: HubContext, route: ScreenRoute) {
  const [directory, catalogue] = await Promise.all([ctx.port.staff(ctx.record.hub.id, ctx.can('admin.staff.read')), ctx.port.roleCatalogue()]);
  const entries = directory?.entries ?? [];
  const requested = route.query.person && UUIDISH.test(route.query.person) ? route.query.person : null;
  const selected = requested ? entries.find((e) => e.personId === requested) ?? null : null;
  const assignable = catalogue.filter((d) => d.scopes.includes('hub') && !SENSITIVE_HUB_STAFF_ROLES.includes(d.role));
  const others = entries.filter((e) => e.personId !== ctx.viewer.person.id);
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('admin.staff.title')} lede={t('admin.staff.lede')} />
      <Panel id="people" title={t('admin.staff.people')}>
        {entries.length ? (
          <table className="plain-table">
            <thead>
              <tr>
                <th scope="col">{t('admin.staff.name')}</th>
                <th scope="col">{t('admin.staff.roles')}</th>
                <th scope="col">{t('admin.staff.secondFactor')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <PersonRow key={e.personId} ctx={ctx} entry={e} selected={e.personId === selected?.personId} />
              ))}
            </tbody>
          </table>
        ) : (
          <p className="admin-empty" data-testid="staff-empty">{t('admin.staff.empty')}</p>
        )}
        <p className="admin-meta">{t('admin.staff.noActivity')}</p>
      </Panel>
      {selected ? <Access ctx={ctx} entry={selected} /> : null}
      <Panel id="add-role" title={t('admin.staff.addRole')}>
        <p className="admin-meta">{t('admin.staff.addRoleHelp')}</p>
        {others.length && assignable.length ? (
          <ConsoleForm
            action={submitConsoleCommand}
            hidden={ctx.hidden('staff.assign')}
            labels={formLabels({ submit: t('admin.staff.addRoleSubmit') })}
            disabledReason={readOnlyReason(ctx.can('admin.staff.assign'), ctx.offline)}
          >
            <SelectField name="personId" label={t('admin.staff.person')} options={others.map((e) => ({ value: e.personId, label: e.displayName, lang: nameLang(ctx) }))} />
            <SelectField name="role" label={t('admin.staff.role')} options={assignable.map((d) => ({ value: d.role, label: tDynamic(`admin.roles.${d.role}`, d.role) }))} />
          </ConsoleForm>
        ) : (
          <p className="admin-empty">{t('admin.staff.nothingToAdd')}</p>
        )}
        <p className="admin-callout" role="note">{t('admin.staff.sensitiveNote', { roles: roleList(SENSITIVE_HUB_STAFF_ROLES) })}</p>
      </Panel>
    </>
  );
}

/** HC-150 Staff: who covers this hub, their roles and second factor, what each may do; add or revoke a hub role. */
export const screen: Screen = { group: 'staff', id: 'staff', title: () => t('admin.staff.title'), render: Staff };
