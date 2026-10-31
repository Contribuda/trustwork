import type { ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';
import { cx } from '../../utils/cx';
import { t } from '../../i18n';
import { ButtonLink } from '../Button/Button';
import { Kicker, Meta } from '../Typography/Typography';
import styles from './DecisionCard.module.css';

export type DecisionTone = 'decision' | 'review' | 'assistant';

export type DecisionCardProps = {
  title: string;
  /** One line of context: «Закупка · 3 предложения на версию 2». */
  summary?: string | undefined;
  /** Meta row items (deadline, owner). */
  meta?: readonly ReactNode[] | undefined;
  /** Primary call to action — the only interactive element of the card. */
  action: { label: string; href: string };
  /** `decision` (amber) = the person must decide; `review` (blue) = something to check; `assistant` (violet) = the assistant is waiting. */
  tone?: DecisionTone | undefined;
  /** Overrides the default kicker text of the tone. */
  kicker?: string | undefined;
  /** Optional extra block (for example a warning strip «Условия изменились»). */
  children?: ReactNode;
  headingLevel?: 2 | 3 | 4 | undefined;
  enterIndex?: number | undefined;
  className?: string | undefined;
};

const defaultKicker: Record<DecisionTone, string> = {
  decision: t('decision.kicker'),
  review: t('decision.review'),
  assistant: t('decision.assistant'),
};

/** Decision card: coloured left rule, kicker, strong title, summary, meta and one CTA. Never colour-only: the kicker names the state. */
export function DecisionCard({ title, summary, meta, action, tone = 'decision', kicker, children, headingLevel = 3, enterIndex, className }: DecisionCardProps) {
  const Heading = `h${headingLevel}` as const;
  return (
    <article className={cx(styles.card, styles[tone], className)} {...(enterIndex !== undefined ? { style: { ['--enter-index' as string]: enterIndex } } : {})}>
      <div className={styles.body}>
        <Kicker as="p" tone="muted" className={styles.kicker}>
          {kicker ?? defaultKicker[tone]}
        </Kicker>
        <Heading className={cx('trustwork-h3', styles.title)}>{title}</Heading>
        {summary ? <p className={cx('trustwork-body', styles.summary)}>{summary}</p> : null}
        {children}
        {meta && meta.length ? <Meta items={meta} /> : null}
      </div>
      <div className={styles.action}>
        <ButtonLink href={action.href} variant={tone === 'decision' ? 'accent' : 'secondary'} icon={ArrowRight}>
          {action.label}
        </ButtonLink>
      </div>
    </article>
  );
}
