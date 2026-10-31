'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Dialog, Modal, ModalOverlay } from 'react-aria-components';
import { writeLocaleCookies } from './locale-cookies';
import { CountrySelect, localeName, type SwitcherCountry, type SwitcherLanguage } from './LocaleSwitcher';
import { t } from '@/app/_lib/i18n';

/**
 * First visit: the country is chosen before anything else, then the language, independently of each
 * other (owner decision 2026-10-29). The deployment's featured packs are cards; every other country it offers
 * (never a restricted place) is in the select. `suggested` is the deployment's default country, or empty when it
 * configures none: then nothing is preselected and the visitor must choose (ADR 012 decision 11). Closing without
 * a choice keeps the default (or no country) and shows the gate again on the next visit; the header switcher is
 * always available afterwards.
 */
export function CountryGate({ countries, languages, suggested, suggestedLocale }: { countries: SwitcherCountry[]; languages: SwitcherLanguage[]; suggested: string; suggestedLocale: string }) {
  const router = useRouter();
  const [country, setCountry] = useState(suggested);
  const [locale, setLocale] = useState(suggestedLocale);
  const [open, setOpen] = useState(true);
  const [pending, startTransition] = useTransition();
  const current = countries.find((c) => c.code === country);
  const featured = countries.filter((c) => c.featured);
  const confirm = () => {
    if (!current) return;
    const tag = languages.some((l) => l.tag === locale) ? locale : (languages[0]?.tag ?? 'en');
    writeLocaleCookies(current.code, tag);
    setOpen(false);
    startTransition(() => router.refresh());
  };
  const pickCountry = (c: SwitcherCountry) => {
    setCountry(c.code);
    // A pack brings its own language as the suggestion; the visitor can still pick any other language.
    if (c.featured && country !== c.code) setLocale(c.defaultLocale);
  };
  return (
    <ModalOverlay isOpen={open} onOpenChange={setOpen} isDismissable className="cg-overlay">
      <Modal className="cg-modal">
        <Dialog className="cg" aria-label={t('locale.gateTitle')}>
          <p className="cg__kicker">{t('locale.gateKicker')}</p>
          <h2 className="cg__title">{t('locale.gateTitle')}</h2>
          <p className="cg__lede">{t('locale.gateLede')}</p>
          <div className="cg__countries" role="radiogroup" aria-label={t('locale.featured')}>
            {featured.map((c) => (
              <button key={c.code} type="button" role="radio" aria-checked={c.code === country} className={`cg__country${c.code === country ? ' is-active' : ''}`} onClick={() => pickCountry(c)}>
                <span className="cg__code">{c.code}</span>
                <span className="cg__name">{c.name}</span>
              </button>
            ))}
          </div>
          <label className="cg__other">
            <span className="cg__other-label">{t('locale.otherCountry')}</span>
            <CountrySelect countries={countries} value={country} onChange={(code) => { const c = countries.find((x) => x.code === code); if (c) pickCountry(c); }} className="cg__select" />
          </label>
          {current && !current.featured ? <p className="cg__chosen">{current.name}</p> : null}
          <p className="cg__section">{t('locale.language')}</p>
          <div className="cg__langs" role="radiogroup" aria-label={t('locale.language')}>
            {languages.map((l) => (
              <button key={l.tag} type="button" role="radio" aria-checked={l.tag === locale} className={`cg__lang${l.tag === locale ? ' is-active' : ''}`} onClick={() => setLocale(l.tag)}>
                {localeName(l.tag)}
                {l.partial ? <span className="cg__partial">{t('locale.partialShort')}</span> : null}
              </button>
            ))}
          </div>
          <div className="cg__actions">
            <button type="button" className="pub-btn pub-btn--accent" onClick={confirm} disabled={pending || !current}>
              {t('locale.gateConfirm')}
            </button>
            <span className="cg__note">{t('locale.gateNote')}</span>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
