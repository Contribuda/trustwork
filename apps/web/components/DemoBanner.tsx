'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { DemoBanner as DemoStrip } from '@trustwork/ui';
import { PERSONAS, resolveDemoContext, type Persona } from '@/app/_lib/persona';
import { t } from '@/app/_lib/i18n';

/** Read at render time, never at module load: the active locale is request-scoped. */
function personaLabel(id: Persona): string {
  return t(`demo.persona.${id}`);
}

/**
 * 32 px demo strip (`@trustwork/ui` DemoBanner) that the root layout renders whenever the fixture adapter is
 * the data source: synthetic data must never masquerade as real customers or a working backend. The layout
 * decides, so this client module never imports the fixtures (their demo content in every language would
 * otherwise ship to every browser). The persona switch is a menu button; choosing an entry navigates to the
 * current path with `?persona=` (cookie-less, see persona.ts) and drops any demo scenario. The strip is last
 * in DOM order (keyboard order starts at the shell) and first visually (`order: -1` on the body flex column).
 */
export function DemoBanner({ defaultPersona }: { defaultPersona: Persona }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const ctx = resolveDemoContext(params, defaultPersona, true);
  const onChange = (id: string) => {
    const next = new URLSearchParams(params.toString());
    next.delete('scenario');
    next.set('persona', id);
    router.push(`${pathname}?${next.toString()}`);
  };
  return (
    <div className="demo-strip" data-testid="demo-banner">
      <DemoStrip message={t('demo.banner')} personas={PERSONAS.map((id) => ({ id, label: personaLabel(id) }))} currentId={ctx.persona} onChange={onChange} />
    </div>
  );
}
