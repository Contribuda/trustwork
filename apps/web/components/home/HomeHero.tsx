'use client';

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import NextLink from 'next/link';
import { ArrowUpRight, ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react';
import { MediaFrame, type MediaRef } from '@trustwork/ui';
import { t } from '@/app/_lib/i18n';
import { typo } from '@/app/_lib/typo';

export type HeroSlide = {
  id: string;
  href: string;
  kicker: string;
  title: string;
  dek: string;
  meta: string[];
  media: MediaRef;
};

const INTERVAL_MS = 7000;
const SWIPE_PX = 48;

/**
 * Lead carousel of the home page. One slide is visible; photographs cross-fade with a slow zoom and the text
 * block rises in on every change. Autoplay (7 s) stops on hover, focus, hidden tab, reduced motion or the
 * explicit pause button; arrows, keyboard (← →), swipe and the dot buttons move between slides. The title is
 * the only link inside the live region, so screen readers get one announcement per slide.
 */
export function HomeHero({ slides }: { slides: HeroSlide[] }) {
  const count = slides.length;
  const [index, setIndex] = useState(0);
  const [cycle, setCycle] = useState(0);
  const [paused, setPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [reduced, setReduced] = useState(true);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const baseId = useId();

  const go = useCallback(
    (next: number) => {
      setIndex(((next % count) + count) % count);
      setCycle((value) => value + 1);
    },
    [count],
  );

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener('change', update);
    const onVisibility = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      query.removeEventListener('change', update);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const running = count > 1 && !paused && !hovered && !focused && !hidden && !reduced;

  useEffect(() => {
    if (!running) return;
    const handle = window.setTimeout(() => go(index + 1), INTERVAL_MS);
    return () => window.clearTimeout(handle);
  }, [running, index, cycle, go]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      go(index + 1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      go(index - 1);
    }
  };
  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === 'mouse') return;
    pointer.current = { x: event.clientX, y: event.clientY };
  };
  const onPointerUp = (event: PointerEvent<HTMLElement>) => {
    const start = pointer.current;
    pointer.current = null;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(dy)) return;
    go(dx < 0 ? index + 1 : index - 1);
  };

  const slide = slides[index];
  if (!slide) return null;
  const pad = (value: number) => String(value).padStart(2, '0');

  return (
    <section
      className="hero-lead"
      aria-roledescription="carousel"
      aria-label={t('home.carouselLabel')}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        pointer.current = null;
      }}
      data-running={running ? 'true' : 'false'}
    >
      <div className="hero-lead__media" aria-hidden="true">
        {slides.map((item, i) => (
          <div key={item.id} className={i === index ? 'hero-lead__slide is-active' : 'hero-lead__slide'}>
            <MediaFrame media={item.media} ratio="fill" radius="none" loading={i === 0 ? 'eager' : 'lazy'} sizes="(max-width: 1023px) 100vw, 66vw" />
          </div>
        ))}
        <div className="hero-lead__scrim" />
      </div>

      <div className="hero-lead__content" key={`${slide.id}-${cycle}`} id={`${baseId}-slide`} aria-live="polite" aria-atomic="true">
        <p className="hero-lead__kicker">{slide.kicker}</p>
        <h2 className="hero-lead__title">
          <NextLink href={slide.href} className="hero-lead__link">
            {typo(slide.title)}
          </NextLink>
        </h2>
        <p className="hero-lead__dek">{typo(slide.dek)}</p>
        <p className="hero-lead__meta">{slide.meta.join(' · ')}</p>
      </div>

      <div className="hero-lead__bottom">
        <NextLink href={slide.href} className="hero-lead__cta" tabIndex={-1} aria-hidden="true">
          {t('home.readMaterial')}
          <ArrowUpRight size={16} strokeWidth={2} aria-hidden="true" />
        </NextLink>
        {count > 1 ? (
          <div className="hero-lead__controls" role="group" aria-label={t('home.slideControls')}>
            <button type="button" className="hero-lead__btn" onClick={() => go(index - 1)} aria-label={t('home.prevSlide')}>
              <ChevronLeft size={18} strokeWidth={2} aria-hidden="true" />
            </button>
            <span className="hero-lead__counter" aria-live="off">
              <span className="hero-lead__counter-current">{pad(index + 1)}</span>
              <span className="hero-lead__counter-sep">/</span>
              <span className="hero-lead__counter-total">{pad(count)}</span>
              <span className="hero-lead__progress" key={cycle} aria-hidden="true" />
            </span>
            <button type="button" className="hero-lead__btn" onClick={() => go(index + 1)} aria-label={t('home.nextSlide')}>
              <ChevronRight size={18} strokeWidth={2} aria-hidden="true" />
            </button>
            <button type="button" className="hero-lead__btn hero-lead__btn--play" onClick={() => setPaused((value) => !value)} aria-pressed={paused} aria-label={paused ? t('home.playSlides') : t('home.pauseSlides')}>
              {paused ? <Play size={14} strokeWidth={2.2} aria-hidden="true" /> : <Pause size={14} strokeWidth={2.2} aria-hidden="true" />}
            </button>
          </div>
        ) : null}
      </div>

      {count > 1 ? (
        <div className="hero-lead__dots" role="tablist" aria-label={t('home.slidesList')}>
          {slides.map((item, i) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={i === index}
              aria-controls={`${baseId}-slide`}
              className={i === index ? 'hero-lead__dot is-active' : 'hero-lead__dot'}
              onClick={() => go(i)}
              aria-label={t('home.slideOf', { current: i + 1, total: count })}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
