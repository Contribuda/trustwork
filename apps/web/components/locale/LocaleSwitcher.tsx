'use client';

import { useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Check, ChevronDown, Globe } from 'lucide-react';
import { Dialog, DialogTrigger, Popover, Button as AriaButton } from 'react-aria-components';
import { publicPathIn, writeLocaleCookies } from './locale-cookies';
import { t } from '@/app/_lib/i18n';

/** A selectable country: the platform's own packs are `featured`; every other country is a generic profile. */
export type SwitcherCountry = { code: string; name: string; featured: boolean; defaultLocale: string };
/**
 * An engine language as the server prepared it: its own name, whether its dictionary still falls back to English
 * (`partial`), and its review status in the active language (INTL-007). Names and review records stay on the server.
 */
export type SwitcherLanguage = { tag: string; name: string; partial: boolean; review: { label: string; description: string } };

/** A language's review label inside its button; the button names `id` so a screen reader adds the sentence behind it. */
export function LanguageReview({ language, id }: { language: SwitcherLanguage; id: string }) {
  return (
    <>
      <span className="lsw-lang__review">{language.review.label}</span>
      <span id={id} hidden>
        {language.review.description}
        {language.partial ? ` ${t('locale.partial')}` : null}
      </span>
    </>
  );
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
 * away, every other country sits in the select, and the language row is independent of the country. Without a
 * country (none chosen and none configured, ADR 012 decision 11) the control says "Country" and asks for one.
 * On a public page the language is the page's own (its URL, ADR 012 decision 27): choosing another opens the same page
 * in that language. Every language shows its review status, a draft as plainly as the rest (INTL-007); `translations`
 * is the link to the public note about them.
 */
export function LocaleSwitcher({ countries, languages, country, locale, translations, tone = 'light' }: { countries: SwitcherCountry[]; languages: SwitcherLanguage[]; country: string; locale: string; translations: ReactNode; tone?: 'light' | 'dark' }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const current = countries.find((c) => c.code === country) ?? null;
  const choose = (code: string, tag: string) => {
    writeLocaleCookies(code, tag);
    setOpen(false);
    const target = tag !== locale ? publicPathIn(tag, window.location, languages.map((l) => l.tag)) : null;
    startTransition(() => (target ? router.push(target) : router.refresh()));
  };
  if (!countries.length) return null;
  const featured = countries.filter((c) => c.featured);
  const code = current ? current.code : t('locale.country');
  const name = current ? current.name : t('locale.chooseCountry');
  const language = languages.find((l) => l.tag === locale)?.name ?? locale;
  return (
    <DialogTrigger isOpen={open} onOpenChange={setOpen}>
      {/* The accessible name starts with the visible text (WCAG 2.5.3) and then names the control. */}
      <AriaButton className={`lsw lsw--${tone}`} aria-label={`${code} ${language} — ${t('locale.switcherLabel', { country: name, language })}`} isDisabled={pending}>
        <Globe size={16} strokeWidth={2} aria-hidden="true" />
        <span className="lsw__code">{code}</span>{' '}
        <span className="lsw__lang">{language}</span>
        <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
      </AriaButton>
      <Popover placement="bottom end" offset={8} className="lsw-pop">
        <Dialog className="lsw-dialog" aria-label={t('locale.dialogLabel')}>
          <p className="lsw-dialog__title">{t('locale.country')}</p>
          <p className="lsw-dialog__current">{name}</p>
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
                <button key={l.tag} type="button" className={`lsw-lang${active ? ' is-active' : ''}`} onClick={() => choose(country, l.tag)} aria-pressed={active} aria-describedby={`lsw-review-${l.tag}`} title={l.partial ? t('locale.partial') : undefined}>
                  {active ? <Check size={12} strokeWidth={2.5} aria-hidden="true" /> : null}
                  {l.name}
                  <LanguageReview language={l} id={`lsw-review-${l.tag}`} />
                  {l.partial ? <span className="lsw-lang__dot" aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>
          <p className="lsw-dialog__note">
            {t('locale.note')} {translations}
          </p>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
