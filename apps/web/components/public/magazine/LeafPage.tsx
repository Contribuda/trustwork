import type { ReactNode } from 'react';
import { t } from '@/app/_lib/i18n';
import { Brand as BrandLockup } from '@/components/ui';
import type { LeafItem, LeafMedia, LeafPage as LeafPageModel } from './leaf-pages';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function Photo({ media, className, eager = false }: { media: LeafMedia; className: string; eager?: boolean }) {
  return <img className={className} src={media.src} {...(media.srcSet ? { srcSet: media.srcSet, sizes: '(max-width: 767px) 90vw, 620px' } : {})} alt="" loading={eager ? 'eager' : 'lazy'} />;
}

function Running({ text, right = false }: { text: string; right?: boolean }) {
  return <span className={`lp__running${right ? ' lp__running--right' : ''}`}>{text}</span>;
}

function Folio({ no, side }: { no: number; side: 'left' | 'right' }) {
  return <span className={`lp__folio lp__folio--${side}`}>{pad(no)}</span>;
}

/** The issue's brand lockup follows the active locale and the deployment overlay like the rest of the UI. */
function Brand({ inverse = false }: { inverse?: boolean }) {
  return (
    <span className={`lp__brand${inverse ? ' lp__brand--inverse' : ''}`}>
      <BrandLockup tone={inverse ? 'inverse' : 'color'} height={40} decorative />
    </span>
  );
}

function Cols({ paragraphs, className = '' }: { paragraphs: string[]; className?: string }) {
  return (
    <div className={`lp__text ${className}`.trim()}>
      {paragraphs.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </div>
  );
}

function Box({ title, children, tone = 'line' }: { title: string; children: ReactNode; tone?: 'line' | 'tint' | 'dark' }) {
  return (
    <div className={`lp__box lp__box--${tone}`}>
      <span className="lp__box-title">{title}</span>
      {children}
    </div>
  );
}

function Byline({ item }: { item: LeafItem }) {
  return (
    <p className="lp__byline">
      {t('magazine.authorPrefix')}: <strong>{item.author}</strong>
      {item.readMinutes ? ` · ${t('magazine.minutesShort', { count: item.readMinutes })}` : ''}
      {item.quizCount ? ` · ${t('magazine.quizTitle')}` : ''}
    </p>
  );
}

/* ------------------------------------------------------------------ rubric templates (left + right page) */

function Report({ item, side }: { item: LeafItem; side: 'left' | 'right' }) {
  if (side === 'left')
    return (
      <>
        <Photo media={item.photo} className="lp__bleed" eager />
        <span className="lp__shade lp__shade--strong" aria-hidden="true" />
        <div className="lp__over">
          <span className="lp__tag lp__tag--light">{item.rubricLabel}</span>
          <h3 className="lp__title lp__title--xl lp__title--light">{item.title}</h3>
          <p className="lp__lede lp__lede--light">{item.lede}</p>
        </div>
      </>
    );
  return (
    <>
      {(item.quote ?? item.intro[0]) ? <blockquote className="lp__quote">{item.quote ?? item.intro[0]}</blockquote> : null}
      <Cols paragraphs={item.paragraphs} className="lp__text--cols lp__text--drop" />
      <figure className="lp__strip">
        <Photo media={item.photo2} className="lp__strip-img" />
        <figcaption>
          {t('magazine.leafPhoto')}: {item.photo2.alt}
        </figcaption>
      </figure>
      <Byline item={item} />
    </>
  );
}

function Interview({ item, side }: { item: LeafItem; side: 'left' | 'right' }) {
  const pairs = item.sections.length ? item.sections : item.paragraphs.map((p, i) => ({ heading: i === 0 ? item.lede : '', text: p }));
  if (side === 'left')
    return (
      <>
        <figure className="lp__hero lp__hero--tall">
          <Photo media={item.photo} className="lp__hero-img" eager />
          <span className="lp__shade" aria-hidden="true" />
          <blockquote className="lp__hero-quote">
            <span aria-hidden="true">«</span>
            {item.quote ?? item.lede}
            <span aria-hidden="true">»</span>
          </blockquote>
        </figure>
        <span className="lp__tag">{item.rubricLabel}</span>
        <h3 className="lp__title lp__title--lg">{item.title}</h3>
        <Byline item={item} />
      </>
    );
  return (
    <>
      <div className="lp__qa lp__fade">
        {pairs.slice(0, 4).map((s, i) => (
          <div key={i} className="lp__qa-pair">
            {s.heading ? <p className="lp__qa-q">— {s.heading}</p> : null}
            <p className="lp__qa-a">— {s.text}</p>
          </div>
        ))}
      </div>
      <span className="lp__more">{t('magazine.leafContinue')}</span>
    </>
  );
}

function People({ item, side }: { item: LeafItem; side: 'left' | 'right' }) {
  if (side === 'left')
    return (
      <>
        <figure className="lp__hero lp__hero--round">
          <Photo media={item.photo} className="lp__hero-img" eager />
        </figure>
        <span className="lp__tag">{item.rubricLabel}</span>
        <h3 className="lp__title lp__title--lg">{item.title}</h3>
        <p className="lp__lede">{item.lede}</p>
        <Byline item={item} />
      </>
    );
  return (
    <>
      <Cols paragraphs={item.paragraphs} className="lp__text--cols lp__text--drop lp__fade" />
      {item.sections.length ? (
        <Box title={t('magazine.leafKeyPoints')} tone="tint">
          <ul className="lp__bullets">
            {item.sections.slice(0, 4).map((s, i) => (
              <li key={i}>{s.heading}</li>
            ))}
          </ul>
        </Box>
      ) : null}
    </>
  );
}

function Analysis({ item, side }: { item: LeafItem; side: 'left' | 'right' }) {
  if (side === 'left')
    return (
      <>
        <span className="lp__numeral" aria-hidden="true">
          {pad(item.position)}
        </span>
        <span className="lp__tag">{item.rubricLabel}</span>
        <h3 className="lp__title lp__title--xl">{item.title}</h3>
        <p className="lp__lede">{item.lede}</p>
        {item.sections.length ? (
          <Box title={t('magazine.leafKeyPoints')} tone="dark">
            <ol className="lp__list">
              {item.sections.slice(0, 3).map((s, i) => (
                <li key={i}>
                  <span>{pad(i + 1)}</span>
                  {s.heading}
                </li>
              ))}
            </ol>
          </Box>
        ) : null}
        <Byline item={item} />
      </>
    );
  return (
    <>
      <Cols paragraphs={item.paragraphs} className="lp__text--cols lp__text--drop lp__fade" />
      <div className="lp__details">
        <div>
          <span className="lp__box-title">{t('magazine.leafDetails')}</span>
          <ol className="lp__list lp__list--tight">
            {(item.sections.length ? item.sections : [{ heading: item.lede, text: '' }]).slice(0, 4).map((s, i) => (
              <li key={i}>
                <span>{pad(i + 1)}</span>
                {s.heading}
              </li>
            ))}
          </ol>
        </div>
        <figure className="lp__thumb">
          <Photo media={item.photo2} className="lp__thumb-img" />
          <figcaption>{item.photo2.alt}</figcaption>
        </figure>
      </div>
    </>
  );
}

function Practice({ item, side }: { item: LeafItem; side: 'left' | 'right' }) {
  const steps = item.sections.length ? item.sections : item.paragraphs.map((p) => ({ heading: p, text: '' }));
  if (side === 'left')
    return (
      <>
        <span className="lp__tag">{item.rubricLabel}</span>
        <h3 className="lp__title lp__title--lg">{item.title}</h3>
        <p className="lp__lede">{item.lede}</p>
        <figure className="lp__hero lp__hero--mid">
          <Photo media={item.photo} className="lp__hero-img" eager />
        </figure>
        {item.intro[0] ? <p className="lp__para">{item.intro[0]}</p> : null}
        <Byline item={item} />
      </>
    );
  return (
    <>
      <span className="lp__box-title">{t('magazine.leafChecklist')}</span>
      <ol className="lp__check lp__fade">
        {steps.slice(0, 5).map((s, i) => (
          <li key={i}>
            <span className="lp__check-box" aria-hidden="true" />
            <span>
              <strong>{s.heading}</strong>
              {s.text ? <em>{s.text}</em> : null}
            </span>
          </li>
        ))}
      </ol>
      {(item.quote ?? item.bullets[0]) ? (
        <Box title={t('magazine.leafTip')} tone="tint">
          <p>{item.quote ?? item.bullets[0]}</p>
        </Box>
      ) : null}
    </>
  );
}

function ProjectStory({ item, side }: { item: LeafItem; side: 'left' | 'right' }) {
  if (side === 'left')
    return (
      <>
        <figure className="lp__hero lp__hero--tall">
          <Photo media={item.photo} className="lp__hero-img" eager />
          <span className="lp__shade" aria-hidden="true" />
          <span className="lp__tag lp__tag--light lp__tag--over">{item.rubricLabel}</span>
        </figure>
        <h3 className="lp__title lp__title--lg">{item.title}</h3>
        <dl className="lp__passport">
          <div>
            <dt>{t('magazine.section')}</dt>
            <dd>{item.rubricLabel}</dd>
          </div>
          <div>
            <dt>{t('magazine.authorPrefix')}</dt>
            <dd>{item.author}</dd>
          </div>
          <div>
            <dt>{t('reader.label')}</dt>
            <dd>{item.readMinutes ? t('magazine.minutesShort', { count: item.readMinutes }) : '—'}</dd>
          </div>
        </dl>
      </>
    );
  return (
    <>
      <span className="lp__box-title">{t('magazine.leafTimeline')}</span>
      <ol className="lp__timeline lp__fade">
        {(item.sections.length ? item.sections : [{ heading: item.lede, text: item.paragraphs[0] ?? '' }]).slice(0, 4).map((s, i) => (
          <li key={i}>
            <strong>{s.heading}</strong>
            {s.text ? <span>{s.text}</span> : null}
          </li>
        ))}
      </ol>
      <p className="lp__lede lp__lede--sm">{item.lede}</p>
    </>
  );
}

function Materials({ item, side }: { item: LeafItem; side: 'left' | 'right' }) {
  if (side === 'left')
    return (
      <>
        <div className="lp__split">
          <figure className="lp__square">
            <Photo media={item.photo} className="lp__hero-img" eager />
          </figure>
          <div>
            <span className="lp__tag">{item.rubricLabel}</span>
            <h3 className="lp__title lp__title--md">{item.title}</h3>
          </div>
        </div>
        <span className="lp__box-title">{t('magazine.leafSpecs')}</span>
        <dl className="lp__spec lp__fade">
          {(item.sections.length ? item.sections : [{ heading: item.lede, text: item.paragraphs[0] ?? '' }]).slice(0, 5).map((s, i) => (
            <div key={i}>
              <dt>{s.heading}</dt>
              <dd>{s.text}</dd>
            </div>
          ))}
        </dl>
      </>
    );
  return (
    <>
      <p className="lp__lede">{item.lede}</p>
      <Cols paragraphs={item.paragraphs} className="lp__text--cols lp__fade" />
      <Box title={t('magazine.leafTerm')} tone="tint">
        <p>{item.quote ?? item.bullets[0] ?? item.sections[0]?.heading ?? item.lede}</p>
      </Box>
      <Byline item={item} />
    </>
  );
}

function Opinion({ item, side }: { item: LeafItem; side: 'left' | 'right' }) {
  const initials = item.author
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase();
  if (side === 'left')
    return (
      <>
        <div className="lp__author">
          <span className="lp__author-mark" aria-hidden="true">
            {initials}
          </span>
          <span>
            <strong>{item.author}</strong>
            <em>{t('magazine.leafColumn')}</em>
          </span>
        </div>
        <blockquote className="lp__quote lp__quote--xl">{item.quote ?? item.lede}</blockquote>
        <span className="lp__tag">{item.rubricLabel}</span>
        <h3 className="lp__title lp__title--lg">{item.title}</h3>
      </>
    );
  return (
    <>
      <Cols paragraphs={item.paragraphs} className="lp__text--wide lp__text--drop lp__fade" />
      <p className="lp__note">{t('magazine.leafSignature')}</p>
      <Byline item={item} />
    </>
  );
}

function Week({ item, side }: { item: LeafItem; side: 'left' | 'right' }) {
  const cards = item.sections.length ? item.sections : item.paragraphs.map((p, i) => ({ heading: `${pad(i + 1)}`, text: p }));
  const left = cards.slice(0, 2);
  const right = cards.slice(2, 6);
  if (side === 'left')
    return (
      <>
        <span className="lp__tag">{item.rubricLabel}</span>
        <h3 className="lp__title lp__title--lg">{t('magazine.leafDigest')}</h3>
        <p className="lp__lede">{item.lede}</p>
        <div className="lp__cards">
          {left.map((c, i) => (
            <article key={i} className="lp__card">
              <span className="lp__card-num">{pad(i + 1)}</span>
              <strong>{c.heading}</strong>
              <p>{c.text}</p>
            </article>
          ))}
        </div>
      </>
    );
  return (
    <>
      <figure className="lp__hero lp__hero--mid lp__hero--top">
        <Photo media={item.photo} className="lp__hero-img" />
      </figure>
      <div className={`lp__cards${right.length > 1 ? ' lp__cards--grid' : ''}`}>
        {right.map((c, i) => (
          <article key={i} className="lp__card">
            <span className="lp__card-num">{pad(i + 3)}</span>
            <strong>{c.heading}</strong>
            <p>{c.text}</p>
          </article>
        ))}
      </div>
      {item.bullets[0] ? <p className="lp__note">{item.bullets[0]}</p> : null}
      <Byline item={item} />
    </>
  );
}

function Numbers({ item, side }: { item: LeafItem; side: 'left' | 'right' }) {
  const stats = item.sections;
  if (side === 'left')
    return (
      <>
        <span className="lp__tag">{item.rubricLabel}</span>
        <h3 className="lp__title lp__title--lg">{item.title}</h3>
        <p className="lp__lede">{item.lede}</p>
        <div className="lp__stats">
          {stats.slice(0, 2).map((s, i) => (
            <div key={i} className="lp__stat">
              <span className="lp__stat-num">{s.heading}</span>
              <p>{s.text}</p>
            </div>
          ))}
        </div>
      </>
    );
  return (
    <>
      <div className="lp__stats lp__stats--grid lp__fade">
        {stats.slice(2, 6).map((s, i) => (
          <div key={i} className="lp__stat">
            <span className="lp__stat-num">{s.heading}</span>
            <p>{s.text}</p>
          </div>
        ))}
      </div>
      {item.quote ? <p className="lp__note">{item.quote}</p> : null}
      <Byline item={item} />
    </>
  );
}

function Qa({ item, side }: { item: LeafItem; side: 'left' | 'right' }) {
  const pairs = item.sections.length ? item.sections : [{ heading: item.lede, text: item.paragraphs[0] ?? '' }];
  const first = pairs.slice(0, 1);
  const rest = pairs.slice(1, 4);
  const Pair = ({ s, i }: { s: { heading: string; text: string }; i: number }) => (
    <div className="lp__qa-block">
      <span className="lp__qa-mark" aria-hidden="true">
        {pad(i + 1)}
      </span>
      <p className="lp__qa-q">{s.heading}</p>
      <p className="lp__qa-a">{s.text}</p>
    </div>
  );
  if (side === 'left')
    return (
      <>
        <span className="lp__tag">{item.rubricLabel}</span>
        <h3 className="lp__title lp__title--lg">{item.title}</h3>
        <p className="lp__lede">{item.lede}</p>
        {first.map((s, i) => (
          <Pair key={i} s={s} i={i} />
        ))}
      </>
    );
  return (
    <>
      <div className="lp__fade lp__qa-list">
        {rest.map((s, i) => (
          <Pair key={i} s={s} i={i + 1} />
        ))}
      </div>
      {item.quote ? <p className="lp__note">{item.quote}</p> : null}
      <Byline item={item} />
    </>
  );
}

const TEMPLATES = {
  report: Report,
  interview: Interview,
  people: People,
  analysis: Analysis,
  practice: Practice,
  projectStory: ProjectStory,
  materials: Materials,
  opinion: Opinion,
  week: Week,
  numbers: Numbers,
  qa: Qa,
} as const;

/* ------------------------------------------------------------------ service pages */

function Cover({ page }: { page: Extract<LeafPageModel, { kind: 'cover' }> }) {
  return (
    <>
      <Photo media={page.media} className="lp__bleed" eager />
      <span className="lp__shade lp__shade--cover" aria-hidden="true" />
      <div className="lp__cover-head">
        <Brand inverse />
        <span className="lp__cover-issue">
          <strong>№ {page.number}</strong>
          <span>{page.dateRange}</span>
        </span>
      </div>
      <div className="lp__cover-foot">
        <h3 className="lp__cover-title">{page.title}</h3>
        <p className="lp__cover-lede">{page.lede}</p>
        <ul className="lp__cover-strip">
          {page.highlights.map((h) => (
            <li key={h}>{h}</li>
          ))}
        </ul>
      </div>
    </>
  );
}

function Contents({ page, running }: { page: Extract<LeafPageModel, { kind: 'contents' }>; running: string }) {
  return (
    <>
      <Running text={running} />
      <h3 className="lp__title lp__title--md lp__contents-title">{t('magazine.contents')}</h3>
      <ol className="lp__contents lp__fade">
        {page.entries.map((e) => (
          <li key={e.position}>
            <span className="lp__contents-page">{pad(e.page)}</span>
            <Photo media={e.photo} className="lp__contents-thumb" />
            <span className="lp__contents-text">
              <strong>{e.title}</strong>
              <em>
                {e.rubric} · {e.author}
              </em>
            </span>
          </li>
        ))}
      </ol>
    </>
  );
}

function Colophon({ page, running }: { page: Extract<LeafPageModel, { kind: 'colophon' }>; running: string }) {
  return (
    <>
      <Running text={running} />
      <h3 className="lp__title lp__title--md lp__contents-title">{t('magazine.colophon')}</h3>
      <dl className="lp__spec">
        <div>
          <dt>{t('magazine.issueTitle', { number: page.number })}</dt>
          <dd>{page.dateRange}</dd>
        </div>
        <div>
          <dt>{t('magazine.colophonVersions', { edition: page.edition })}</dt>
          <dd>{page.releasedAt}</dd>
        </div>
        <div>
          <dt>{t('magazine.itemsCount', { count: page.itemsCount })}</dt>
          <dd>{t('magazine.readMinutes', { count: page.readMinutes })}</dd>
        </div>
        <div>
          <dt>{t('magazine.colophonAuthors')}</dt>
          <dd>{page.authors.join(', ')}</dd>
        </div>
        {page.corrections.length ? (
          <div>
            <dt>{t('magazine.corrections')}</dt>
            <dd>{page.corrections.join('; ')}</dd>
          </div>
        ) : null}
      </dl>
      {page.glossary.length ? (
        <Box title={t('magazine.glossaryTitle')} tone="tint">
          <dl className="lp__gloss">
            {page.glossary.map((g) => (
              <div key={g.term}>
                <dt>{g.term}</dt>
                <dd>{g.definition}</dd>
              </div>
            ))}
          </dl>
        </Box>
      ) : null}
      <p className="lp__note">{t('magazine.colophonSources')}</p>
    </>
  );
}

function Back({ page }: { page: Extract<LeafPageModel, { kind: 'back' }> }) {
  return (
    <div className="lp__back">
      <Brand inverse />
      <p className="lp__back-next">{t('magazine.backNextDate', { date: page.nextDate })}</p>
      {page.poll ? (
        <div className="lp__back-poll">
          <span className="lp__box-title">{t('magazine.pollTitle')}</span>
          <strong>{page.poll.question}</strong>
          <ul>
            {page.poll.options.map((o) => (
              <li key={o}>{o}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="lp__back-rubrics">
        <span className="lp__box-title">{t('magazine.backRubrics')}</span>
        <ul>
          {page.rubrics.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </div>
      <p className="lp__back-foot">{t('magazine.backSuggest')}</p>
    </div>
  );
}

/** One page of the printed preview: cover, contents, a rubric-specific opener or text page, colophon or back cover. */
export function LeafPage({ page, running, side }: { page: LeafPageModel | null; running: string; side: 'left' | 'right' }) {
  if (!page) return <div className={`leaf-page lp lp--blank lp--${side}`} aria-hidden="true" />;
  const label = t('magazine.pageOf', { page: page.no });
  if (page.kind === 'cover')
    return (
      <div className={`leaf-page lp lp--cover lp--${side}`} aria-label={label}>
        <Cover page={page} />
      </div>
    );
  if (page.kind === 'contents')
    return (
      <div className={`leaf-page lp lp--contents lp--${side}`} aria-label={label}>
        <Contents page={page} running={running} />
        <Folio no={page.no} side={side} />
      </div>
    );
  if (page.kind === 'colophon')
    return (
      <div className={`leaf-page lp lp--colophon lp--${side}`} aria-label={label}>
        <Colophon page={page} running={running} />
        <Folio no={page.no} side={side} />
      </div>
    );
  if (page.kind === 'back')
    return (
      <div className={`leaf-page lp lp--back lp--${side}`} aria-label={label}>
        <Back page={page} />
      </div>
    );
  const Template = TEMPLATES[page.item.rubric] ?? Analysis;
  const bleed = page.item.rubric === 'report' && page.side === 'left';
  return (
    <div className={`leaf-page lp lp--item lp--${page.item.rubric} lp--${page.side}${bleed ? ' lp--bleed' : ''} lp--${side}`} aria-label={label} data-rubric={page.item.rubric}>
      {!bleed ? <Running text={page.side === 'left' ? running : page.item.rubricLabel} right={page.side === 'right'} /> : null}
      <Template item={page.item} side={page.side} />
      {!bleed ? <Folio no={page.no} side={side} /> : null}
    </div>
  );
}
