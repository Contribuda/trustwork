import { Check } from 'lucide-react';
import { cx } from '../../utils/cx';
import { t } from '../../i18n';
import { Icon } from '../Icon/Icon';
import { VisuallyHidden } from '../VisuallyHidden/VisuallyHidden';
import styles from './Stepper.module.css';

export type StepperStep = { id: string; label: string };

export type StepperProps = {
  steps: readonly StepperStep[];
  /** 1-based index of the current step. */
  current: number;
  label?: string | undefined;
  className?: string | undefined;
};

/** Onboarding progress: ordered list with `aria-current="step"`, plus the text «Шаг N из M» for announcements. */
export function Stepper({ steps, current, label = t('onboardingFlow.stepsLabel'), className }: StepperProps) {
  return (
    <nav aria-label={label} className={cx(styles.root, className)}>
      <p className={styles.summary} aria-live="polite">
        {t('onboardingFlow.step', { index: current, total: steps.length })}
      </p>
      <ol className={styles.list}>
        {steps.map((step, i) => {
          const index = i + 1;
          const state = index < current ? 'done' : index === current ? 'current' : 'upcoming';
          return (
            <li key={step.id} className={cx(styles.step, styles[state])} {...(state === 'current' ? { 'aria-current': 'step' } : {})}>
              <span className={styles.marker} aria-hidden="true">
                {state === 'done' ? <Icon icon={Check} size={16} /> : index}
              </span>
              <span className={styles.label}>
                {step.label}
                {state === 'done' ? <VisuallyHidden> ({t('common.stepDone')})</VisuallyHidden> : null}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
