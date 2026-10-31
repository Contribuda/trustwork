'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowUpRight, Clock, FileText, FolderOpen, Globe, LocateFixed, MapPin, MessageSquareText, Minus, Plus, RefreshCw, ShoppingCart, Users, X } from 'lucide-react';
import { CompanyMark } from '@/components/public/CompanyMark';
import { SRMark } from '@/components/public/SRMark';
import { t } from '@/app/_lib/i18n';

export type PinTone = 'navy' | 'blue' | 'green' | 'amber' | 'grey';
export type MapFactIcon = 'region' | 'projects' | 'publications' | 'needs' | 'people' | 'updated' | 'site';

/** One pin on the map; everything is serialisable (built on the server from public cards only). */
export type MapItem = {
  id: string;
  href: string;
  title: string;
  /** Small caps line: kinds / category. */
  kicker: string;
  subtitle: string | null;
  description: string | null;
  lat: number;
  lng: number;
  /** Short label in the pin (monogram or percent). */
  pin: string;
  pinTone: PinTone;
  /** Photo URL for the card header; companies without photos fall back to their mark. */
  cover: string | null;
  mark: { name: string; seed: string } | null;
  /** Record state (sourced / claimed / verified) or project status; `sr` renders the accreditation mark. */
  status: { label: string; tone: 'free' | 'paid' | 'muted' | 'sr' };
  /** Self-declared statuses (hiring, accepting orders…), already localised. */
  signals: string[];
  facts: Array<{ icon: MapFactIcon; label: string; href?: string }>;
  /** 0–100 readiness for projects. */
  progress: number | null;
  agentHref: string | null;
};

export type MapLegendEntry = { tone: PinTone; label: string };

type Bbox = [number, number, number, number];
type LeafletMap = {
  on: (e: string, h: () => void) => void;
  off: (e: string, h: () => void) => void;
  getBounds: () => { getWest: () => number; getSouth: () => number; getEast: () => number; getNorth: () => number };
  fitBounds: (b: [[number, number], [number, number]], o?: object) => void;
  setView: (c: [number, number], z: number, o?: object) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  remove: () => void;
  invalidateSize: () => void;
  getZoom: () => number;
  getSize: () => { x: number; y: number };
  latLngToContainerPoint: (p: [number, number]) => { x: number; y: number };
};
type LeafletMarker = { addTo: (m: LeafletMap) => LeafletMarker; on: (e: string, h: () => void) => LeafletMarker; remove: () => void; getElement: () => HTMLElement | undefined; setZIndexOffset: (n: number) => void };
type Leaflet = {
  map: (el: HTMLElement, o: object) => LeafletMap;
  tileLayer: (url: string, o: object) => { addTo: (m: LeafletMap) => void };
  marker: (pos: [number, number], o: object) => LeafletMarker;
  divIcon: (o: object) => unknown;
  latLngBounds: (a: [number, number], b: [number, number]) => { extend: (p: [number, number]) => void };
};

const LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
const TILES = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>';

/** Pins closer than this (CSS px) collapse into a cluster count marker at the current zoom. */
const CLUSTER_PX = 44;
/** Card geometry used to place the anchored popup next to its pin. */
const POP_W = 340;
const POP_GAP = 12;
const PIN_H = 40;

const FACT_ICONS = { region: MapPin, projects: FolderOpen, publications: FileText, needs: ShoppingCart, people: Users, updated: Clock, site: Globe } as const;

function escapeHtml(v: string): string {
  return v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

let leafletPromise: Promise<Leaflet> | null = null;
function loadLeaflet(): Promise<Leaflet> {
  if (leafletPromise) return leafletPromise;
  leafletPromise = new Promise((resolve, reject) => {
    const w = window as unknown as { L?: Leaflet };
    if (w.L) return resolve(w.L);
    if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = LEAFLET_CSS;
      document.head.appendChild(link);
    }
    const script = document.createElement('script');
    script.src = LEAFLET_JS;
    script.async = true;
    script.onload = () => (w.L ? resolve(w.L) : reject(new Error('leaflet missing')));
    script.onerror = () => reject(new Error('leaflet failed'));
    document.head.appendChild(script);
  });
  return leafletPromise;
}

function bboxOf(map: LeafletMap): Bbox {
  const b = map.getBounds();
  const r = (n: number) => Math.round(n * 10000) / 10000;
  return [r(b.getWest()), r(b.getSouth()), r(b.getEast()), r(b.getNorth())];
}

function StatusChip({ status }: { status: MapItem['status'] }) {
  return status.tone === 'sr' ? <SRMark size="sm" /> : <span className={`ev-badge ev-badge--${status.tone}`}>{status.label}</span>;
}

function Facts({ facts, max }: { facts: MapItem['facts']; max: number }) {
  return (
    <ul className="ms-facts">
      {facts.slice(0, max).map((f) => {
        const Icon = FACT_ICONS[f.icon];
        return (
          <li key={`${f.icon}:${f.label}`}>
            <Icon size={13} strokeWidth={2} aria-hidden="true" />
            {f.href ? (
              <a href={f.href} target="_blank" rel="noopener noreferrer">
                {f.label}
              </a>
            ) : (
              <span>{f.label}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Split map search (Zillow / Airbnb pattern): result cards on the left, the map on the right. Hovering a card lifts
 * its pin; hovering a pin opens a preview card anchored next to the pin, a click pins it. Pins that overlap at the
 * current zoom collapse into a count cluster (click zooms in). Moving the map offers «search this area» (or does it
 * automatically when the toggle is on) by writing `bbox` into the URL, so the server applies the same filters.
 */
export function MapSearch({
  items,
  legend,
  baseQuery,
  basePath,
  bbox,
  total,
  listHref,
  focusId = null,
}: {
  items: MapItem[];
  legend: MapLegendEntry[];
  baseQuery: string;
  basePath: string;
  bbox: Bbox | null;
  total: number;
  listHref: string;
  focusId?: string | null;
}) {
  const router = useRouter();
  const mapRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const mapObj = useRef<LeafletMap | null>(null);
  const markers = useRef<Map<string, LeafletMarker>>(new Map());
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [moved, setMoved] = useState(false);
  const [auto, setAuto] = useState(false);
  const autoRef = useRef(false);
  const searchRef = useRef<(b: Bbox) => void>(() => undefined);
  /** Pinned card (click / locate) and hover preview (pin mouseover). */
  const [active, setActive] = useState<string | null>(focusId);
  const [peek, setPeek] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [anchored, setAnchored] = useState(false);
  const pending = useRef<number | null>(null);
  const peekTimer = useRef<number | null>(null);
  const itemsKey = useMemo(() => items.map((i) => i.id).join(','), [items]);
  const shownId = active ?? peek;
  const current = items.find((i) => i.id === shownId) ?? null;

  const search = (b: Bbox) => {
    const q = new URLSearchParams(baseQuery);
    q.set('view', 'map');
    q.set('bbox', b.join(','));
    router.replace(`${basePath}?${q.toString()}`, { scroll: false });
    setMoved(false);
  };
  searchRef.current = search;
  const clearArea = () => {
    const q = new URLSearchParams(baseQuery);
    q.set('view', 'map');
    router.replace(`${basePath}?${q.toString()}`, { scroll: false });
    setMoved(false);
  };
  const holdPeek = () => {
    if (peekTimer.current) window.clearTimeout(peekTimer.current);
    peekTimer.current = null;
  };
  const releasePeek = () => {
    holdPeek();
    peekTimer.current = window.setTimeout(() => setPeek(null), 220);
  };

  /* Desktop with a pointer: card is anchored to the pin; touch / narrow: bottom sheet. */
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px) and (hover: hover)');
    const sync = () => setAnchored(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    let disposed = false;
    loadLeaflet()
      .then((L) => {
        if (disposed || !mapRef.current || mapObj.current) return;
        const map = L.map(mapRef.current, { zoomControl: false, attributionControl: true, scrollWheelZoom: true });
        L.tileLayer(TILES, { attribution: ATTRIBUTION, maxZoom: 18 }).addTo(map);
        mapObj.current = map;
        let first = true;
        const onMove = () => {
          if (first) {
            first = false;
            return;
          }
          if (autoRef.current) {
            if (pending.current) window.clearTimeout(pending.current);
            pending.current = window.setTimeout(() => searchRef.current(bboxOf(map)), 450);
          } else setMoved(true);
        };
        map.on('moveend', onMove);
        map.on('click', () => {
          setActive(null);
          setPeek(null);
        });
        const focus = focusId ? items.find((i) => i.id === focusId) : null;
        if (focus) map.setView([focus.lat, focus.lng], 12);
        else if (bbox)
          map.fitBounds(
            [
              [bbox[1], bbox[0]],
              [bbox[3], bbox[2]],
            ],
            { padding: [0, 0] },
          );
        else if (items.length) {
          const bounds = L.latLngBounds([items[0]!.lat, items[0]!.lng], [items[0]!.lat, items[0]!.lng]);
          items.forEach((i) => bounds.extend([i.lat, i.lng]));
          map.fitBounds(bounds as unknown as [[number, number], [number, number]], { padding: [48, 48], maxZoom: 12 });
        } else map.setView([55.75, 37.62], 5);
        setReady(true);
      })
      .catch(() => setFailed(true));
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    const map = mapObj.current;
    if (!ready || !map) return;
    let off: (() => void) | null = null;
    loadLeaflet().then((L) => {
      /* Greedy grid clustering in screen space: pins closer than CLUSTER_PX collapse into one count marker. */
      const render = () => {
        markers.current.forEach((m) => m.remove());
        markers.current.clear();
        const groups: Array<{ members: MapItem[]; x: number; y: number }> = [];
        items.forEach((it) => {
          const p = map.latLngToContainerPoint([it.lat, it.lng]);
          const g = groups.find((c) => Math.hypot(c.x - p.x, c.y - p.y) < CLUSTER_PX);
          if (g) {
            g.members.push(it);
            g.x = (g.x * (g.members.length - 1) + p.x) / g.members.length;
            g.y = (g.y * (g.members.length - 1) + p.y) / g.members.length;
          } else groups.push({ members: [it], x: p.x, y: p.y });
        });
        groups.forEach((g) => {
          if (g.members.length === 1) {
            const it = g.members[0]!;
            const icon = L.divIcon({ className: 'ms-pin-wrap', html: `<span class="ms-pin ms-pin--${it.pinTone}">${escapeHtml(it.pin)}</span>`, iconSize: [40, 40], iconAnchor: [20, 36] });
            const marker = L.marker([it.lat, it.lng], { icon, title: it.title, riseOnHover: true }).addTo(map);
            marker.on('click', () => {
              setPeek(null);
              setActive((cur) => (cur === it.id ? null : it.id));
            });
            marker.on('mouseover', () => {
              holdPeek();
              setPeek(it.id);
            });
            marker.on('mouseout', releasePeek);
            markers.current.set(it.id, marker);
            return;
          }
          const lat = g.members.reduce((a, m) => a + m.lat, 0) / g.members.length;
          const lng = g.members.reduce((a, m) => a + m.lng, 0) / g.members.length;
          const icon = L.divIcon({ className: 'ms-pin-wrap', html: `<span class="ms-pin ms-pin--cluster">${g.members.length}</span>`, iconSize: [44, 44], iconAnchor: [22, 22] });
          const marker = L.marker([lat, lng], { icon, title: t('map.clusterTitle', { count: g.members.length }), riseOnHover: true }).addTo(map);
          marker.on('click', () => {
            const b = L.latLngBounds([g.members[0]!.lat, g.members[0]!.lng], [g.members[0]!.lat, g.members[0]!.lng]);
            g.members.forEach((m) => b.extend([m.lat, m.lng]));
            setActive(null);
            setPeek(null);
            map.fitBounds(b as unknown as [[number, number], [number, number]], { padding: [64, 64], maxZoom: 15 });
          });
          markers.current.set(`cluster:${g.members.map((m) => m.id).join('|')}`, marker);
        });
      };
      render();
      map.on('zoomend', render);
      off = () => map.off('zoomend', render);
    });
    return () => off?.();
  }, [ready, itemsKey]);

  /* Pin + card highlight sync; a pinned item hidden inside a cluster zooms the map to it. */
  useEffect(() => {
    const map = mapObj.current;
    const it = items.find((i) => i.id === active);
    if (map && it && ready && markers.current.size > 0 && !markers.current.has(it.id)) map.setView([it.lat, it.lng], Math.max(map.getZoom(), 12));
    if (it) document.getElementById(`ms-card-${it.id}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    markers.current.forEach((m, id) => {
      const el = m.getElement();
      if (!el) return;
      el.classList.toggle('is-hover', id === hover || id === peek);
      el.classList.toggle('is-active', id === active);
      m.setZIndexOffset(id === active ? 1000 : id === hover || id === peek ? 500 : 0);
    });
  }, [hover, peek, active, ready, itemsKey]);

  /* Anchor the card next to its pin and keep it there while the map moves. */
  useLayoutEffect(() => {
    const map = mapObj.current;
    const el = popRef.current;
    if (!anchored || !map || !el || !current) return;
    const place = () => {
      const size = map.getSize();
      const pt = map.latLngToContainerPoint([current.lat, current.lng]);
      const h = el.offsetHeight;
      const half = POP_W / 2;
      const clampX = (x: number) => Math.min(Math.max(x, 8), Math.max(8, size.x - POP_W - 8));
      const clampY = (y: number) => Math.min(Math.max(y, 8), Math.max(8, size.y - h - 8));
      /* Preferred: above the pin; then below, right, left; otherwise above with the top clamped into view. */
      let side: 'above' | 'below' | 'right' | 'left' = 'above';
      if (pt.y - PIN_H - POP_GAP - h < 8) {
        if (pt.y + POP_GAP + h <= size.y - 8) side = 'below';
        else if (pt.x + 28 + POP_W <= size.x - 8) side = 'right';
        else if (pt.x - 28 - POP_W >= 8) side = 'left';
      }
      let left: number;
      let top: number;
      if (side === 'above' || side === 'below') {
        left = clampX(pt.x - half);
        top = side === 'above' ? clampY(pt.y - PIN_H - POP_GAP - h) : pt.y + POP_GAP;
        el.style.setProperty('--ms-arrow-x', `${Math.min(Math.max(pt.x - left, 24), POP_W - 24)}px`);
      } else {
        left = side === 'right' ? pt.x + 28 : pt.x - 28 - POP_W;
        top = clampY(pt.y - PIN_H / 2 - h / 2);
        el.style.setProperty('--ms-arrow-y', `${Math.min(Math.max(pt.y - PIN_H / 2 - top, 24), h - 24)}px`);
      }
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      el.classList.remove('ms-pop--above', 'ms-pop--below', 'ms-pop--right', 'ms-pop--left');
      el.classList.add(`ms-pop--${side}`);
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    map.on('move', place);
    map.on('zoom', place);
    map.on('resize', place);
    return () => {
      ro.disconnect();
      map.off('move', place);
      map.off('zoom', place);
      map.off('resize', place);
    };
  }, [anchored, current, ready]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setActive(null);
        setPeek(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="ms">
      <div className="ms__list" aria-label={t('map.listLabel')}>
        <div className="ms__head">
          <span className="ev-results__count">
            {t('map.inArea')}: <strong>{items.length}</strong>
            {bbox && total !== items.length ? <span className="ms__total"> · {t('map.ofTotal', { total })}</span> : null}
          </span>
          {bbox ? (
            <button type="button" className="ev-active__chip" onClick={clearArea}>
              {t('map.clearArea')}
              <X size={12} strokeWidth={2.5} aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <ul className="ms__legend" aria-label={t('map.legend')}>
          {legend.map((l) => (
            <li key={l.tone}>
              <span className={`ms__dot ms__dot--${l.tone}`} aria-hidden="true" />
              {l.label}
            </li>
          ))}
        </ul>
        {items.length === 0 ? (
          <div className="cp-empty">
            <p>{t('map.empty')}</p>
            <button type="button" className="pub-more" onClick={clearArea}>
              {t('map.clearArea')}
            </button>
          </div>
        ) : (
          <ul className="ms__cards">
            {items.map((it) => (
              <li
                id={`ms-card-${it.id}`}
                key={it.id}
                className={`ms-card${it.id === shownId ? ' is-active' : ''}`}
                onMouseEnter={() => setHover(it.id)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(it.id)}
                onBlur={() => setHover(null)}
              >
                <span className="ms-card__thumb" aria-hidden="true">
                  {it.cover ? <img src={it.cover} alt="" loading="lazy" /> : it.mark ? <CompanyMark name={it.mark.name} seed={it.mark.seed} size={52} /> : null}
                  {it.progress !== null ? <span className="ms-card__pct">{it.progress}%</span> : null}
                </span>
                <div className="ms-card__body">
                  <span className="pub-kicker">{it.kicker}</span>
                  <a href={it.href} className="ms-card__title">
                    {it.title}
                  </a>
                  {it.subtitle ? <span className="ms-card__sub">{it.subtitle}</span> : null}
                  <div className="ms-card__foot">
                    <StatusChip status={it.status} />
                    <Facts facts={it.facts.filter((f) => f.icon !== 'region' && f.icon !== 'site')} max={2} />
                  </div>
                </div>
                <button type="button" className="ms-card__locate" aria-label={t('map.showOnMap')} onClick={() => setActive(it.id)}>
                  <LocateFixed size={14} strokeWidth={2} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="ms__map">
        <div ref={mapRef} className="ms__canvas" role="application" aria-label={t('map.mapLabel')} />
        {!ready && !failed ? <div className="ms__loading">{t('map.loading')}</div> : null}
        {failed ? (
          <div className="ms__loading">
            {t('map.failed')} <a href={listHref}>{t('map.toList')}</a>
          </div>
        ) : null}
        <div className="ms__controls">
          <button type="button" className="ms__ctl" aria-label={t('map.zoomIn')} onClick={() => mapObj.current?.zoomIn()}>
            <Plus size={16} strokeWidth={2} aria-hidden="true" />
          </button>
          <button type="button" className="ms__ctl" aria-label={t('map.zoomOut')} onClick={() => mapObj.current?.zoomOut()}>
            <Minus size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
        <label className="ms__auto">
          <input
            type="checkbox"
            checked={auto}
            onChange={(e) => {
              autoRef.current = e.target.checked;
              setAuto(e.target.checked);
              if (e.target.checked && mapObj.current) search(bboxOf(mapObj.current));
            }}
          />
          {t('map.autoSearch')}
        </label>
        {moved && !auto ? (
          <button type="button" className="ms__search pub-btn pub-btn--dark" onClick={() => mapObj.current && search(bboxOf(mapObj.current))}>
            <RefreshCw size={16} strokeWidth={2} aria-hidden="true" />
            {t('map.searchHere')}
          </button>
        ) : null}
        {current ? (
          <div
            ref={popRef}
            key={current.id}
            className={`ms-pop${anchored ? ' ms-pop--anchored' : ''}${active ? ' is-pinned' : ''}`}
            role="dialog"
            aria-label={current.title}
            onMouseEnter={holdPeek}
            onMouseLeave={() => {
              if (!active) releasePeek();
            }}
          >
            <button
              type="button"
              className="ms-pop__close"
              aria-label={t('companyPage.repClose')}
              onClick={() => {
                setActive(null);
                setPeek(null);
              }}
            >
              <X size={14} strokeWidth={2} aria-hidden="true" />
            </button>
            {current.cover ? (
              <a href={current.href} className="ms-pop__cover" tabIndex={-1} aria-hidden="true">
                <img src={current.cover} alt="" />
                {current.progress !== null ? (
                  <span className="ms-pop__progress" style={{ ['--p' as string]: `${current.progress}%` }}>
                    <span />
                  </span>
                ) : null}
              </a>
            ) : null}
            <div className="ms-pop__body">
              <div className="ms-pop__head">
                {current.mark ? <CompanyMark name={current.mark.name} seed={current.mark.seed} size={44} /> : null}
                <div className="ms-pop__heading">
                  <span className="pub-kicker">{current.kicker}</span>
                  <a href={current.href} className="ms-pop__title">
                    {current.title}
                  </a>
                </div>
              </div>
              {current.subtitle ? <span className="ms-card__sub">{current.subtitle}</span> : null}
              {current.description ? <p className="ms-pop__desc">{current.description}</p> : null}
              <div className="ms-pop__status">
                <StatusChip status={current.status} />
                {current.progress !== null ? <span className="ms-pop__pct">{t('map.readiness', { percent: current.progress })}</span> : null}
                {current.signals.map((s) => (
                  <span key={s} className="ms-pop__signal">
                    {s}
                  </span>
                ))}
              </div>
              <Facts facts={current.facts} max={4} />
              <div className="ms-pop__actions">
                <a href={current.href} className="pub-btn pub-btn--dark ms-pop__open">
                  {t('map.open')}
                  <ArrowUpRight size={16} strokeWidth={2} aria-hidden="true" />
                </a>
                {current.agentHref ? (
                  <a href={current.agentHref} className="pub-btn ms-pop__agent">
                    <MessageSquareText size={16} strokeWidth={2} aria-hidden="true" />
                    {t('map.talk')}
                  </a>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
