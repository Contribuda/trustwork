import { CONSULTATION_KINDS } from '../../../../../../packages/contracts/src/consultations.js';
import en from '../../../../locales/en/pricing.json' with { type: 'json' };
import es from '../../../../locales/es/pricing.json' with { type: 'json' };
import ru from '../../../../locales/ru/pricing.json' with { type: 'json' };
import uz from '../../../../locales/uz-Latn/pricing.json' with { type: 'json' };
import ka from '../../../../locales/ka/pricing.json' with { type: 'json' };
import hy from '../../../../locales/hy/pricing.json' with { type: 'json' };
import az from '../../../../locales/az-Latn/pricing.json' with { type: 'json' };

// Checked against data/taxonomy in the owning test; locale assets also ship in the web image.
const taskCodes = new Set<string>(Object.keys(en.pricing.taskCategories));
const labels: Record<string, Record<string, string>> = { en: en.pricing.taskCategories, es: es.pricing.taskCategories, ru: ru.pricing.taskCategories, 'uz-Latn': uz.pricing.taskCategories, ka: ka.pricing.taskCategories, hy: hy.pricing.taskCategories, 'az-Latn': az.pricing.taskCategories };

/** Presentation lookup only: a taxonomy label never authorizes a fee mapping or creates a commercial category. */
type CategoryMessage = 'pricing.allCategories' | `consultations.kind.${(typeof CONSULTATION_KINDS)[number]}`;
export function publicFeeCategory(kind: string, category: string | null, locale: string, translate: (key: CategoryMessage) => string): string | null {
  if (category === null) return translate('pricing.allCategories');
  const consultation = CONSULTATION_KINDS.find(value => value === category);
  if (kind === 'consultation' && consultation) return translate(`consultations.kind.${consultation}`);
  if (kind === 'task' && taskCodes.has(category)) return labels[locale]?.[category] ?? null;
  return null;
}
