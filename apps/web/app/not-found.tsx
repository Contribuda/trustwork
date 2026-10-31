import type { Metadata } from 'next';
import { currentDeployment } from '@trustwork/config/server';
import { messageIn } from '@/app/_lib/locale';
import { withBase } from '@/app/_lib/base-path';

export function generateMetadata(): Metadata {
  return { title: messageIn(currentDeployment().languages.default, 'error.notFoundTitle'), robots: { index: false, follow: false } };
}

/**
 * Last-resort 404 for addresses outside every document (WEB-005): public addresses get the public 404 in their
 * language and the workspace its own; this one answers the rest (an unknown path under a sign-in or onboarding
 * address). Next renders this boundary inside every page's tree, public pages included, so it reads no cookie,
 * leaves the request's locale alone (`messageIn`) and stays a minimal, unstyled document in the deployment's default
 * language: importing the global stylesheets here as well would let them be ordered after the documents' own.
 */
export default function NotFound() {
  const lang = currentDeployment().languages.default;
  const t = (key: string) => messageIn(lang, key);
  return (
    <html lang={lang}>
      <body>
        <main id="main" className="page page--narrow" tabIndex={-1}>
          <section className="row" aria-labelledby="root-404-title">
            <h1 id="root-404-title" tabIndex={-1}>
              {t('error.notFoundTitle')}
            </h1>
            <p>{t('error.notFoundBody')}</p>
            <div className="row__actions">
              <a href={withBase('/')}>{t('auth.backHome')}</a>
            </div>
          </section>
        </main>
      </body>
    </html>
  );
}
