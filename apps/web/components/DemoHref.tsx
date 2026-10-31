'use client';

import { useSearchParams } from 'next/navigation';

/** Client-side counterpart of `withDemo`: keeps `?persona=`/`?scenario=` from the current URL on a link (error and 404 boundaries). */
export function useDemoHref(): (href: string) => string {
  const params = useSearchParams();
  const persona = params.get('persona');
  const scenario = params.get('scenario');
  return (href: string) => {
    const query = [persona ? `persona=${encodeURIComponent(persona)}` : null, scenario && scenario !== 'default' ? `scenario=${encodeURIComponent(scenario)}` : null].filter(Boolean).join('&');
    if (!query) return href;
    const [path, hash] = href.split('#');
    return `${path}${path?.includes('?') ? '&' : '?'}${query}${hash ? `#${hash}` : ''}`;
  };
}
