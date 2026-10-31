'use client';

import { useState } from 'react';
import { Check, RotateCcw, X } from 'lucide-react';
import type { QuizQuestion } from '@/app/_lib/data/types';
import { t } from '@/app/_lib/i18n';
import { typo } from '@/app/_lib/typo';

/**
 * «Проверь себя»: one question at a time, check, explanation, next; the final score is reported to the parent,
 * which stores it in the browser. Nothing is sent anywhere.
 */
export function Quiz({ questions, stored, onDone }: { questions: QuizQuestion[]; stored: { score: number; total: number } | null; onDone: (score: number, total: number) => void }) {
  const [index, setIndex] = useState(0);
  const [choice, setChoice] = useState<number | null>(null);
  const [checked, setChecked] = useState(false);
  const [score, setScore] = useState(0);
  const [finished, setFinished] = useState(stored !== null);
  const q = questions[index];
  const total = questions.length;

  const restart = () => {
    setIndex(0);
    setChoice(null);
    setChecked(false);
    setScore(0);
    setFinished(false);
  };

  if (finished || !q) {
    const final = finished && stored && score === 0 ? stored : { score, total };
    return (
      <section className="quiz quiz--done" aria-label={t('magazine.quizTitle')}>
        <span className="quiz__kicker">{t('magazine.quizTitle')}</span>
        <p className="quiz__score">{t('magazine.quizScore', { score: final.score, total: final.total })}</p>
        <button type="button" className="pub-btn pub-btn--sm" onClick={restart}>
          <RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
          {t('magazine.quizRetry')}
        </button>
      </section>
    );
  }

  const correct = checked && choice === q.answer;
  return (
    <section className="quiz" aria-label={t('magazine.quizTitle')}>
      <span className="quiz__kicker">
        {t('magazine.quizTitle')} · {index + 1}/{total}
      </span>
      <p className="quiz__lede">{t('magazine.quizLede')}</p>
      <p className="quiz__question">{typo(q.question)}</p>
      <div className="quiz__options" role="radiogroup" aria-label={typo(q.question)}>
        {q.options.map((opt, i) => {
          const state = checked ? (i === q.answer ? 'right' : i === choice ? 'wrong' : 'idle') : choice === i ? 'picked' : 'idle';
          return (
            <button key={opt} type="button" role="radio" aria-checked={choice === i} className={`quiz__option quiz__option--${state}`} disabled={checked} onClick={() => setChoice(i)}>
              <span className="quiz__mark" aria-hidden="true">
                {state === 'right' ? <Check size={14} strokeWidth={2.5} /> : state === 'wrong' ? <X size={14} strokeWidth={2.5} /> : String.fromCharCode(1040 + i)}
              </span>
              {typo(opt)}
            </button>
          );
        })}
      </div>
      {checked ? (
        <p className={`quiz__verdict quiz__verdict--${correct ? 'right' : 'wrong'}`} role="status">
          <strong>{correct ? t('magazine.quizRight') : t('magazine.quizWrong')}.</strong> {typo(q.explanation)}
        </p>
      ) : null}
      <div className="quiz__actions">
        {!checked ? (
          <button
            type="button"
            className="pub-btn pub-btn--dark pub-btn--sm"
            disabled={choice === null}
            onClick={() => {
              setChecked(true);
              if (choice === q.answer) setScore((s) => s + 1);
            }}
          >
            {t('magazine.quizCheck')}
          </button>
        ) : (
          <button
            type="button"
            className="pub-btn pub-btn--dark pub-btn--sm"
            onClick={() => {
              if (index + 1 >= total) {
                const finalScore = score;
                onDone(finalScore, total);
                setFinished(true);
              } else {
                setIndex(index + 1);
                setChoice(null);
                setChecked(false);
              }
            }}
          >
            {index + 1 >= total ? t('magazine.quizScore', { score, total }) : t('magazine.quizNext')}
          </button>
        )}
      </div>
    </section>
  );
}
