import en from './en.json' with { type: 'json' };
import es from './es.json' with { type: 'json' };
import uz from './uz-Latn.json' with { type: 'json' };
import ka from './ka.json' with { type: 'json' };
import hy from './hy.json' with { type: 'json' };
import az from './az-Latn.json' with { type: 'json' };

/**
 * Russian is not maintained (ADR 009 decision 11): it renders the English reference, because a mail with a missing key
 * would not be sent, and this notice cannot be muted or dropped.
 */
export const screeningStaffNoticeDictionaries = { en, es, ru: en, 'uz-Latn': uz, ka, hy, 'az-Latn': az };

/** The notice takes no parameter at all: nothing about the subject can reach it. */
export function validateScreeningStaffNotice(params: Readonly<Record<string, string>>): void {
  if (Object.keys(params).length !== 0) throw new Error('screening staff notice accepts no parameter');
}
