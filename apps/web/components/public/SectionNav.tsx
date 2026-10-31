'use client';

import { useEffect, useRef, useState } from 'react';

/** Sticky in-page navigation with scroll-spy: the last section whose top has passed under the bar is marked. */
export function SectionNav({ items, label }: { items: Array<{ id: string; label: string }>; label: string }) {
  const [active, setActive] = useState<string>(items[0]?.id ?? '');
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const sections = items.map((it) => document.getElementById(it.id)).filter((el): el is HTMLElement => Boolean(el));
    if (!sections.length) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const line = (navRef.current?.getBoundingClientRect().bottom ?? 120) + 96;
      let current = sections[0]!.id;
      for (const s of sections) if (s.getBoundingClientRect().top <= line) current = s.id;
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) current = sections[sections.length - 1]!.id;
      setActive(current);
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [items]);
  return (
    <nav className="cp-nav" aria-label={label} ref={navRef}>
      <ul className="cp-nav__list">
        {items.map((it) => (
          <li key={it.id}>
            <a
              href={`#${it.id}`}
              className="cp-nav__link"
              aria-current={active === it.id ? 'location' : undefined}
              onClick={(event) => {
                const target = document.getElementById(it.id);
                if (!target) return;
                event.preventDefault();
                const offset = (navRef.current?.getBoundingClientRect().height ?? 48) + 16;
                const top = window.scrollY + target.getBoundingClientRect().top - offset;
                const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
                window.scrollTo({ top, behavior: reduce ? 'auto' : 'smooth' });
                window.history.replaceState(null, '', `#${it.id}`);
                setActive(it.id);
              }}
            >
              {it.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
