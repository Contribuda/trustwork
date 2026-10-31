'use client';

import { useState } from 'react';
import type { GlossaryEntry } from '@/app/_lib/data/types';
import { t } from '@/app/_lib/i18n';
import { typo } from '@/app/_lib/typo';

/** Flash cards: term on the front, definition on the back; click or Enter flips a card. */
export function Glossary({ entries }: { entries: GlossaryEntry[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (term: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(term)) next.delete(term);
      else next.add(term);
      return next;
    });
  return (
    <ul className="mg-gloss">
      {entries.map((g) => {
        const flipped = open.has(g.term);
        return (
          <li key={g.term}>
            <button type="button" className={`mg-gloss__card${flipped ? ' is-flipped' : ''}`} aria-pressed={flipped} onClick={() => toggle(g.term)}>
              <span className="mg-gloss__inner">
                <span className="mg-gloss__face mg-gloss__face--front">
                  <span className="mg-gloss__kicker">{t('magazine.glossaryTerm')}</span>
                  <span className="mg-gloss__term">{typo(g.term)}</span>
                  <span className="mg-gloss__hint">{t('magazine.glossaryFlip')}</span>
                </span>
                <span className="mg-gloss__face mg-gloss__face--back">
                  <span className="mg-gloss__term mg-gloss__term--sm">{typo(g.term)}</span>
                  <span className="mg-gloss__def">{typo(g.definition)}</span>
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
