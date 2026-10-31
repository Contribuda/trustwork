import { Boxes, Building2, Camera, ClipboardCheck, Hash, Layers, MessageCircleQuestion, MessageSquareText, Newspaper, PenLine, Users, type LucideIcon } from 'lucide-react';
import type { RubricKey } from '@/app/_lib/data/types';
import { t } from '@/app/_lib/i18n';

export const RUBRIC_ICONS: Record<RubricKey, LucideIcon> = {
  analysis: Layers,
  practice: ClipboardCheck,
  report: Camera,
  interview: MessageSquareText,
  people: Users,
  projectStory: Building2,
  materials: Boxes,
  opinion: PenLine,
  week: Newspaper,
  numbers: Hash,
  qa: MessageCircleQuestion,
};

export function rubricLabel(key: RubricKey): string {
  return t(`magazine.rubrics.${key}` as 'magazine.rubrics.analysis');
}

export function rubricDescription(key: RubricKey): string {
  return t(`magazine.rubricDesc.${key}` as 'magazine.rubricDesc.analysis');
}

/** Small rubric pill; `link` turns it into a link to the rubric page. */
export function RubricChip({ rubric, link = false, size = 'sm' }: { rubric: RubricKey; link?: boolean; size?: 'sm' | 'md' }) {
  const Icon = RUBRIC_ICONS[rubric];
  const cls = `mg-rubric mg-rubric--${size}`;
  const inner = (
    <>
      <Icon size={size === 'sm' ? 12 : 14} strokeWidth={2} aria-hidden="true" />
      {rubricLabel(rubric)}
    </>
  );
  return link ? (
    <a href={`/magazine/rubric/${rubric}`} className={cls}>
      {inner}
    </a>
  ) : (
    <span className={cls}>{inner}</span>
  );
}

export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  const word = mod10 === 1 && mod100 !== 11 ? one : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many;
  return `${n} ${word}`;
}
