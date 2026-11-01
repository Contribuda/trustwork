import { CONSULTATION_KINDS } from '../../../../../../packages/contracts/src/consultations.js';
import workTypes from '../../../../../../data/taxonomy/terms/work-types.json' with { type: 'json' };
import en from '../../../../../../data/taxonomy/locales/en.json' with { type: 'json' };
import es from '../../../../../../data/taxonomy/locales/es.json' with { type: 'json' };
import ru from '../../../../../../data/taxonomy/locales/ru.json' with { type: 'json' };
import uz from '../../../../../../data/taxonomy/locales/uz-Latn.json' with { type: 'json' };
import ka from '../../../../../../data/taxonomy/locales/ka.json' with { type: 'json' };
import hy from '../../../../../../data/taxonomy/locales/hy.json' with { type: 'json' };
import az from '../../../../../../data/taxonomy/locales/az-Latn.json' with { type: 'json' };

const taskCodes = new Set<string>(workTypes.terms.map(term => term.code));
const labels: Record<string, Record<string, string>> = { en: en.labels, es: es.labels, ru: ru.labels, 'uz-Latn': uz.labels, ka: ka.labels, hy: hy.labels, 'az-Latn': az.labels };

/** Presentation lookup only: a taxonomy label never authorizes a fee mapping or creates a commercial category. */
type CategoryMessage = 'pricing.allCategories' | `consultations.kind.${(typeof CONSULTATION_KINDS)[number]}`;
export function publicFeeCategory(kind: string, category: string | null, locale: string, translate: (key: CategoryMessage) => string): string | null {
  if (category === null) return translate('pricing.allCategories');
  const consultation = CONSULTATION_KINDS.find(value => value === category);
  if (kind === 'consultation' && consultation) return translate(`consultations.kind.${consultation}`);
  if (kind === 'task' && taskCodes.has(category)) return labels[locale]?.[category] ?? null;
  return null;
}
