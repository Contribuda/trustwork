'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, ChevronDown, Globe } from 'lucide-react';
import { Dialog, DialogTrigger, Popover, Button as AriaButton } from 'react-aria-components';
import { writeLocaleCookies } from './locale-cookies';
import { t } from '@/app/_lib/i18n';

/** A selectable country: the platform's own packs are `featured`; every other country is a generic profile. */
export type SwitcherCountry = { code: string; name: string; featured: boolean; defaultLocale: string };
/** An engine language; `partial` marks dictionaries that still fall back to English. */
export type SwitcherLanguage = { tag: string; partial: boolean };

const LOCALE_NAMES: Record<string, string> = { en: 'English', ru: 'Русский', 'uz-Latn': 'Oʻzbekcha', ka: 'ქართული', hy: 'Հայերեն', 'az-Latn': 'Azərbaycanca' };
export function localeName(tag: string): string {
  return LOCALE_NAMES[tag] ?? tag;
}

/** Native `<select>` over every non-featured country: accessible, searchable by typing, no extra script. */
export function CountrySelect({ countries, value, onChange, className, id }: { countries: SwitcherCountry[]; value: string; onChange: (code: string) => void; className: string; id?: string }) {
  const others = countries.filter((c) => !c.featured);
  const selected = others.some((c) => c.code === value) ? value : '';
  return (
    <select id={id} className={className} value={selected} onChange={(event) => event.target.value && onChange(event.target.value)} aria-label={t('locale.otherCountry')}>
      <option value="">{t('locale.chooseCountry')}</option>
      {others.map((c) => (
        <option key={c.code} value={c.code}>
          {c.name} ({c.code})
        </option>
      ))}
    </select>
  );
}

/**
 * Header control: the active country and language. Any country that is not a restricted place can be
 * combined with any engine language (owner decision 2026-10-29): the platform's own packs are one click
 * away, every other country sits in the select, and the language row is independent of the country.
 */
export function LocaleSwitcher({ countries, languages, country, locale, tone = 'light' }: { countries: SwitcherCountry[]; languages: SwitcherLanguage[]; country: string; locale: string; tone?: 'light' | 'dark' }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const current = countries.find((c) => c.code === country) ?? countries[0];
  const choose = (code: string, tag: string) => {
    writeLocaleCookies(code, tag);
    setOpen(false);
    startTransition(() => router.refresh());
  };
  if (!current) return null;
  const featured = countries.filter((c) => c.featured);
  return (
    <DialogTrigger isOpen={open} onOpenChange={setOpen}>
      {/* The accessible name starts with the visible text (WCAG 2.5.3) and then names the control. */}
      <AriaButton className={`lsw lsw--${tone}`} aria-label={`${current.code} ${localeName(locale)} — ${t('locale.switcherLabel', { country: current.name, language: localeName(locale) })}`} isDisabled={pending}>
        <Globe size={16} strokeWidth={2} aria-hidden="true" />
        <span className="lsw__code">{current.code}</span>{' '}
        <span className="lsw__lang">{localeName(locale)}</span>
        <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
      </AriaButton>
      <Popover placement="bottom end" offset={8} className="lsw-pop">
        <Dialog className="lsw-dialog" aria-label={t('locale.dialogLabel')}>
          <p className="lsw-dialog__title">{t('locale.country')}</p>
          <p className="lsw-dialog__current">{current.name}</p>
          <div className="lsw-featured" role="group" aria-label={t('locale.featured')}>
            {featured.map((c) => {
              const active = c.code === country;
              return (
                <button key={c.code} type="button" className={`lsw-country${active ? ' is-active' : ''}`} onClick={() => choose(c.code, locale)} aria-pressed={active}>
                  <span className="lsw-item__code">{c.code}</span>
                  {c.name}
                </button>
              );
            })}
          </div>
          <CountrySelect countries={countries} value={country} onChange={(code) => choose(code, locale)} className="lsw-select" />
          <p className="lsw-dialog__title">{t('locale.language')}</p>
          <div className="lsw-item__langs" role="group" aria-label={t('locale.language')}>
            {languages.map((l) => {
              const active = l.tag === locale;
              return (
                <button key={l.tag} type="button" className={`lsw-lang${active ? ' is-active' : ''}`} onClick={() => choose(country, l.tag)} aria-pressed={active} title={l.partial ? t('locale.partial') : undefined}>
                  {active ? <Check size={12} strokeWidth={2.5} aria-hidden="true" /> : null}
                  {localeName(l.tag)}
                  {l.partial ? <span className="lsw-lang__dot" aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>
          <p className="lsw-dialog__note">{t('locale.note')}</p>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
