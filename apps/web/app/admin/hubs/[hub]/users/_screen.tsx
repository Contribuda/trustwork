import NextLink from '@/components/locale/LocalLink';
import { t } from '@/app/_lib/i18n';
import type { HubContext } from '../../../_components/context';
import type { Screen, ScreenRoute } from '../../../_components/screen';
import { ConsoleHeader, DeniedState, Panel } from '../../../_components/shell';
import { USER_VIEWS, userView } from '../../../_navigation/model';
import { deviceScope, navigationCopy } from '../../../_navigation/server';
import { SavedTabs } from '../../../_navigation/SavedTabs';
import { participantsOf } from '../participants/_fixtures';
import s from '../../../_navigation/navigation.module.css';

export async function Users(ctx: HubContext, route: ScreenRoute) {
  const copy = navigationCopy();
  const view = userView(route.query.view);
  const readable = new Set(ctx.nav.flatMap((group) => group.sections.map((section) => section.path)));
  const path = view === 'people' || view === 'companies' ? `participants/${view}` : view === 'staff' ? 'staff' : 'staff/clients';
  const permitted = readable.has(path);
  const options = USER_VIEWS.map((id) => ({ id: `users:${id}` as const, label: copy[id], href: ctx.href('users', { view: id }) }));
  const demo = ctx.request.demo && ctx.port.source === 'fixtures';
  // Use the owning fixture projection and explicitly select public display fields. Never serialize the source object.
  const data = demo && permitted && (view === 'people' || view === 'companies') ? participantsOf(ctx.record.hub.id) : null;
  const rows = view === 'people' ? data?.profiles.map((profile) => ({ id: profile.id, name: profile.name })) ?? [] : view === 'companies' ? data?.companies.map((company) => ({ id: company.id, name: company.name })) ?? [] : [];
  return <>
    <ConsoleHeader ctx={ctx} title={copy.users} lede={copy.usersLede} />
    <p className="admin-callout">{copy.publicOnly}</p>
    <nav className={s.tabs} aria-label={copy.users}>{options.map((option) => <NextLink key={option.id} href={option.href} aria-current={option.id === `users:${view}` ? 'page' : undefined}>{option.label}</NextLink>)}</nav>
    <SavedTabs scope={deviceScope(ctx)} current={`users:${view}`} options={options} copy={copy} />
    <Panel id={`users-${view}`} title={copy[view]}>
      {!demo || view === 'clients' ? <p>{copy.unavailable}</p> : !permitted ? <DeniedState title={t('admin.denied.title')} /> : view === 'staff' ? <>
        <p>{copy.unavailable}</p><NextLink href={ctx.href('staff')}>{copy.openStaff}</NextLink>
      </> : <>
        <p>{copy.syntheticRows}</p><NextLink href={ctx.href(path)}>{copy.openPublic}</NextLink>
        {rows.length ? <ul className={s.records} data-testid="users-public-projection">{rows.map((row) => <li key={row.id} className={s.record}>
          <h3 lang={row.name.lang}>{row.name.value}</h3>
          <NextLink href={`${ctx.href(path)}#${view === 'people' ? 'profiles' : 'directory'}`}>{copy.openPublic}</NextLink>
          {readable.has('support') ? <NextLink href={ctx.href('support')}>{copy.participantLookup}</NextLink> : null}
        </li>)}</ul> : <p>{copy.empty}</p>}
        <p>{copy.privacyNote}</p>
      </>}
    </Panel>
  </>;
}

export const screen: Screen = { group: 'home', id: 'users', title: () => t('consoleNav.users'), render: Users };
