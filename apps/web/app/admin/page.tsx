import type { Metadata } from 'next';
import NextLink from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { t, tDynamic } from '@/app/_lib/i18n';
import { primeLocale } from '@/app/_lib/locale';
import { consoleHref } from './_data/personas';
import { consoleRequest, type PageSearchParams } from './_components/context';
import { country, localized } from './_components/format';
import { AdminShell, DeniedState, KeyValues, Panel, roleList, StatusLabel } from './_components/shell';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: t('admin.landing.title') };
}

/**
 * `/admin` (docs/engine/hub-console/README.md): a viewer whose roles cover one hub goes straight to its overview;
 * a viewer covering several (node or platform roles) gets the node's hub list, never a switcher; a signed-in person
 * without a staff role sees the denied state; anyone else gets "not found".
 */
export default async function AdminLanding({ searchParams }: { searchParams: PageSearchParams }) {
  await primeLocale();
  const { request, port } = await consoleRequest(searchParams);
  const viewer = await port.viewer(request);
  if (!viewer) notFound();
  const node = await port.node();
  if (!node) notFound();
  const hubs = await port.hubs(request);
  const covered = (
    await Promise.all(hubs.map(async (record) => ({ record, access: await port.access(viewer, { nodeId: record.hub.nodeId, hubId: record.hub.id }) })))
  ).filter((entry) => entry.access.roles.length > 0);
  if (covered.length === 1 && viewer.elevation.state === 'elevated') redirect(consoleHref(`/admin/hubs/${covered[0]!.record.hub.slug}`, request));
  const nodeAccess = await port.access(viewer, { nodeId: node.id, hubId: null });
  return (
    <AdminShell request={request} hub={null} viewer={viewer} roles={nodeAccess.roles} nav={null} current={null} navHref={(p) => p} helpHref={null} selfPath="/admin">
      {covered.length === 0 ? (
        <DeniedState title={t('admin.denied.noStaffTitle')} body={t('admin.denied.noStaffBody')} />
      ) : (
        <>
          <header className="admin-head">
            <p className="admin-head__kicker">
              {t('admin.landing.node')} <strong lang="en">{node.name}</strong>
            </p>
            <div className="admin-head__row">
              <h1 tabIndex={-1} className="admin-h1">
                {t('admin.landing.title')}
              </h1>
              <StatusLabel status="demo" />
            </div>
            <p className="admin-lede">{t('admin.landing.lede')}</p>
          </header>
          <ul className="admin-cards" data-testid="admin-hub-list">
            {covered.map(({ record, access }) => {
              const name = localized(record.hub.name, [record.hub.defaultLocale]);
              return (
                <li key={record.hub.id}>
                  <Panel title={name.text} titleLang={name.lang} id={`hub-${record.hub.slug}`}>
                    <KeyValues
                      rows={[
                        { label: t('admin.landing.stage'), value: tDynamic(`admin.lifecycle.${record.hub.lifecycle}`, record.hub.lifecycle) },
                        { label: t('admin.landing.country'), value: country(record.hub.territories[0]!.code.slice(0, 2)) },
                        { label: t('admin.landing.data'), value: tDynamic(`admin.hub.modes.dataMode.${record.modes.dataMode}`, record.modes.dataMode) },
                        { label: t('admin.landing.yourRoles'), value: roleList(access.roles) },
                      ]}
                    />
                    <p className="admin-card__action">
                      <NextLink href={consoleHref(`/admin/hubs/${record.hub.slug}`, request)} className="admin-link-strong">
                        {t('admin.landing.open')}
                        <span className="admin-visually-hidden">
                          {' '}
                          <span lang={name.lang}>{name.text}</span>
                        </span>
                      </NextLink>
                    </p>
                  </Panel>
                </li>
              );
            })}
          </ul>
          <section className="admin-section" aria-labelledby="node-console-title">
            <div className="admin-head__row">
              <h2 id="node-console-title" className="admin-h2">
                {t('admin.landing.nodeConsole')}
              </h2>
              <StatusLabel status="designed" />
            </div>
            <p>{t('admin.landing.nodeConsoleStatus')}</p>
          </section>
        </>
      )}
    </AdminShell>
  );
}
