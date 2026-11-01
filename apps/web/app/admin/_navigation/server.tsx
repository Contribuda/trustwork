import { createHash } from 'node:crypto';
import { tDynamic, currentLocale } from '@/app/_lib/i18n';
import { appNamespace } from '@/app/_lib/locale-data';
import type { HubContext } from '../_components/context';
import { NavigationLayer } from './NavigationLayer';
import type { NavigationCopy, NavigationDestination } from './model';
import { permittedForms } from './forms';

export function navigationCopy(): NavigationCopy {
  const reference = appNamespace('en', 'console-navigation') as { consoleNav: NavigationCopy };
  return Object.fromEntries(Object.keys(reference.consoleNav).map((key) => [key, tDynamic(`consoleNav.${key}`, '')])) as NavigationCopy;
}

/** Opaque partition derived from the resolved viewer and hub, never from URL identity suggestions. */
export function deviceScope(ctx: HubContext): string {
  return createHash('sha256').update(JSON.stringify([ctx.port.source, ctx.viewer.person.id, ctx.record.hub.nodeId, ctx.record.hub.id])).digest('hex');
}

export function NavigationTools({ ctx }: { ctx: HubContext }) {
  const copy = navigationCopy();
  const destinations: NavigationDestination[] = ctx.nav.flatMap((group) => group.sections.map((section) => ({
    id: `${group.id}:${section.id}`,
    label: tDynamic(section.labelKey ?? `admin.sections.${group.id}.${section.id}`, section.id),
    href: ctx.href(section.path), kind: section.id === 'help' ? 'help' as const : 'section' as const,
  })));
  for (const form of permittedForms(ctx.nav, ctx.access)) destinations.push({ id: form.command, label: copy[form.label], href: `${ctx.href(form.path)}#${form.fragment}`, kind: 'command' });
  const support = ctx.nav.some((group) => group.sections.some((section) => section.path === 'support'))
    ? { id: 'support-lookup', label: copy.participantLookup, href: ctx.href('support'), kind: 'section' as const } : null;
  return <NavigationLayer key={deviceScope(ctx)} scope={deviceScope(ctx)} copy={copy} locale={currentLocale()} destinations={destinations} support={support} current={tDynamic(ctx.current.section.labelKey ?? `admin.sections.${ctx.current.group.id}.${ctx.current.section.id}`, ctx.current.section.id)} />;
}
