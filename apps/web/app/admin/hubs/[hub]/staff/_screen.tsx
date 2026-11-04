import { SENSITIVE_HUB_STAFF_ROLES } from '@trustwork/contracts/client';
import { t, tDynamic } from '@/app/_lib/i18n';
import NextLink from '@/components/locale/LocalLink';
import { submitConsoleCommand } from '../../../_data/actions';
import { invitationStage, type InvitationStage } from '../../../_data/commands';
import { ConsoleForm } from '../../../_components/ConsoleForm';
import type { HubContext } from '../../../_components/context';
import type { Screen, ScreenRoute } from '../../../_components/screen';
import { formLabels, readOnlyReason, SelectField, TextInput } from '../../../_components/forms';
import { dateTime, number } from '../../../_components/format';
import { ConsoleHeader, KeyValues, Panel, roleList } from '../../../_components/shell';
import type { StaffDirectoryEntry, StaffDirectoryRole, StaffInvitationView } from '../../../../../../../packages/contracts/src/staff-lifecycle.js';

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

/** How long the role lasts once applied: whole days, or hours under a day (the API allows one hour to 366 days). */
function validity(seconds: number | null): string {
  if (seconds === null) return t('admin.staff.invitation.noEnd');
  const days = Math.round(seconds / 86_400);
  return days >= 1 ? t('admin.overview.days', { count: days }) : t('admin.staff.invitation.forHours', { count: Math.max(1, Math.round(seconds / 3600)) });
}

const STAGE_PILL: Record<InvitationStage, string> = {
  response: 'pending', apply: 'pending', second_person: 'pending', approved: 'passed', expired: 'expired', declined: 'closed', applied: 'passed', withdrawn: 'closed',
};

function InvitationRow({ ctx, invitation, stage, entries }: { ctx: HubContext; invitation: StaffInvitationView; stage: InvitationStage; entries: readonly StaffDirectoryEntry[] }) {
  const zone = ctx.record.hub.timeZone;
  const here = invitation.scope.kind === 'hub' && invitation.scope.hubId === ctx.record.hub.id;
  const inviter = entries.find((e) => e.personId === invitation.invitedBy);
  const mine = invitation.invitedBy === ctx.viewer.person.id;
  const open = stage === 'response' || stage === 'apply' || stage === 'second_person' || stage === 'approved';
  const applicable = stage === 'apply' || stage === 'approved';
  const asksSecondPerson = invitation.sensitive && stage === 'apply';
  const canAssign = readOnlyReason(ctx.can('admin.staff.assign'), ctx.offline);
  return (
    <li className="admin-approval" data-testid={`invitation-${invitation.id}`} data-stage={stage}>
      <div className="admin-panel__head">
        <h3 className="admin-h3">
          <code className="admin-code">{invitation.email}</code>
        </h3>
        <span className={`admin-pill admin-pill--${STAGE_PILL[stage]}`}>{t(`admin.staff.invitation.stage.${stage}`)}</span>
      </div>
      <KeyValues
        rows={[
          { label: t('admin.staff.role'), value: invitation.sensitive ? t('admin.staff.invitation.sensitiveRole', { role: tDynamic(`admin.roles.${invitation.role}`, invitation.role) }) : tDynamic(`admin.roles.${invitation.role}`, invitation.role) },
          { label: t('admin.staff.invitation.scope'), value: invitation.scope.kind === 'hub' ? (here ? t('admin.staff.scope.thisHub') : t('admin.staff.scope.otherHub')) : t(`admin.staff.scope.${invitation.scope.kind}`) },
          { label: t('admin.staff.invitation.length'), value: validity(invitation.validForSeconds) },
          { label: t('admin.staff.invitation.invitedBy'), value: mine ? t('admin.common.you') : inviter ? <span lang={nameLang(ctx)}>{inviter.displayName}</span> : t('admin.common.staffMember') },
          { label: t('admin.approvals.reason'), value: invitation.reason, lang: nameLang(ctx) },
          ...(open ? [{ label: t('admin.staff.invitation.openUntil'), value: dateTime(invitation.expiresAt, zone) }] : []),
        ]}
      />
      {!here ? <p className="admin-meta">{t('admin.staff.managedAtNode')}</p> : null}
      {here && stage === 'second_person' ? (
        <p className="admin-meta">
          {t('admin.staff.invitation.waitingSecondPerson')} <NextLink href={ctx.href('approvals')}>{t('admin.overview.openApprovals')}</NextLink>
        </p>
      ) : null}
      {here && applicable && !mine ? <p className="admin-meta">{t('admin.errors.not_inviter')}</p> : null}
      {here && applicable && mine ? (
        <details className="admin-staff__revoke">
          <summary>{t('admin.staff.invitation.apply')}</summary>
          <ConsoleForm
            action={submitConsoleCommand}
            hidden={ctx.hidden('staff.invitation_apply', { 'f.invitationId': invitation.id })}
            labels={formLabels({ submit: t('admin.staff.invitation.applySubmit'), secondPerson: asksSecondPerson })}
            disabledReason={canAssign}
          />
        </details>
      ) : null}
      {here && open ? (
        <details className="admin-staff__revoke">
          <summary>{t('admin.staff.invitation.withdraw')}</summary>
          <ConsoleForm
            action={submitConsoleCommand}
            hidden={ctx.hidden('staff.invitation_withdraw', { 'f.invitationId': invitation.id })}
            labels={formLabels({ submit: t('admin.staff.invitation.withdrawSubmit') })}
            submitVariant="secondary"
            disabledReason={canAssign}
          />
        </details>
      ) : null}
    </li>
  );
}

async function Staff(ctx: HubContext, route: ScreenRoute) {
  const hubId = ctx.record.hub.id;
  const [directory, catalogue, invitations, approvals] = await Promise.all([ctx.port.staff(hubId, ctx.can('admin.staff.read')), ctx.port.roleCatalogue(), ctx.port.staffInvitations(hubId), ctx.port.approvals(hubId)]);
  const entries = directory?.entries ?? [];
  const requested = route.query.person && UUIDISH.test(route.query.person) ? route.query.person : null;
  const selected = requested ? entries.find((e) => e.personId === requested) ?? null : null;
  const assignable = catalogue.filter((d) => d.scopes.includes('hub') && !SENSITIVE_HUB_STAFF_ROLES.includes(d.role));
  const others = entries.filter((e) => e.personId !== ctx.viewer.person.id);
  // Ordinary roles first, so a sensitive one is never the form's default.
  const invitable = catalogue.filter((d) => d.scopes.includes('hub')).sort((a, b) => Number(SENSITIVE_HUB_STAFF_ROLES.includes(a.role)) - Number(SENSITIVE_HUB_STAFF_ROLES.includes(b.role)));
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
      <Panel id="invite" title={t('admin.staff.invite')}>
        <p className="admin-meta">{t('admin.staff.inviteHelp')}</p>
        {ctx.request.demo ? (
          <p className="admin-meta">
            <NextLink href="/app/settings?persona=mixed&invitation=demo#staff-invitations">{t('admin.staff.inviteeView')}</NextLink>
          </p>
        ) : null}
        {invitable.length ? (
          <ConsoleForm
            action={submitConsoleCommand}
            hidden={ctx.hidden('staff.invite')}
            labels={formLabels({ submit: t('admin.staff.inviteSubmit') })}
            disabledReason={readOnlyReason(ctx.can('admin.staff.assign'), ctx.offline)}
          >
            <div className="admin-form__grid">
              <TextInput name="email" label={t('admin.staff.inviteEmail')} isRequired />
              <SelectField
                name="role"
                label={t('admin.staff.role')}
                options={invitable.map((d) => {
                  const label = tDynamic(`admin.roles.${d.role}`, d.role);
                  return { value: d.role, label: SENSITIVE_HUB_STAFF_ROLES.includes(d.role) ? t('admin.staff.invitation.sensitiveRole', { role: label }) : label };
                })}
              />
              <TextInput name="validForDays" label={t('admin.staff.inviteDays')} description={t('admin.staff.inviteDaysHelp')} />
            </div>
          </ConsoleForm>
        ) : (
          <p className="admin-empty">{t('admin.staff.nothingToInvite')}</p>
        )}
      </Panel>
      <Panel id="invitations" title={t('admin.staff.invitations')} aside={invitations?.length ? <span className="admin-count">{number(invitations.length)}</span> : undefined}>
        {invitations?.length ? (
          <ul className="admin-approvals">
            {invitations.map((i) => (
              <InvitationRow key={i.id} ctx={ctx} invitation={i} entries={entries} stage={invitationStage(i, approvals.requests, approvals.decisions, ctx.now)} />
            ))}
          </ul>
        ) : (
          <p className="admin-empty" data-testid="invitations-empty">{t('admin.staff.invitationsEmpty')}</p>
        )}
      </Panel>
    </>
  );
}

/** HC-150 Staff: who covers this hub, their roles and second factor, what each may do; add or revoke a hub role; invite someone new. */
export const screen: Screen = { group: 'staff', id: 'staff', title: () => t('admin.staff.title'), render: Staff };
