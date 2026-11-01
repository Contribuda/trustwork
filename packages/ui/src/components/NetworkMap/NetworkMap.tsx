import { useRef, useState } from "react";
import { t } from "../../i18n";
import { Button } from "../Button/Button";
import { selectableTerritories } from "./places";
import s from "../DataTable/console.module.css";
export type NetworkHub = {
  id: string;
  label: string;
  territories: readonly string[];
  territoryLabel: string;
  stateLabel: string;
  peeringLabel: string;
  longitude: number;
  latitude: number;
};
/** Bundled schematic world outline; no tiles, services, analytics or location requests. */
export function NetworkMap({
  label,
  hubs,
  onOpen,
}: {
  label: string;
  hubs: readonly NetworkHub[];
  onOpen: (id: string) => void;
}) {
  const safe = hubs.filter(
    (h) =>
      selectableTerritories(h.territories) &&
      Number.isFinite(h.longitude) &&
      Math.abs(h.longitude) <= 180 &&
      Number.isFinite(h.latitude) &&
      Math.abs(h.latitude) <= 90,
  );
  const [zoom, setZoom] = useState(1);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  return (
    <section className={s.stack} aria-label={label}>
      <h2>{label}</h2>
      <div className={s.row}>
        <Button
          variant="secondary"
          isDisabled={zoom >= 3}
          onPress={() => setZoom(zoom + 0.5)}
        >
          {t("consoleKit.zoomIn")}
        </Button>
        <Button
          variant="secondary"
          isDisabled={zoom <= 1}
          onPress={() => setZoom(zoom - 0.5)}
        >
          {t("consoleKit.zoomOut")}
        </Button>
      </div>
      <div className={s.map}>
        <div
          ref={ref}
          className={s.mapCanvas}
          style={{ width: `${zoom * 100}%`, height: `${zoom * 22}rem` }}
        >
          <svg
            viewBox="0 0 360 180"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path
              fill="var(--color-border)"
              stroke="var(--color-border-strong)"
              d="M18 29 L65 20 100 36 87 57 70 70 55 67 45 49Z M73 78 L104 82 117 106 104 139 92 157 81 118Z M147 36 L179 26 197 36 189 53 160 56Z M155 62 L187 58 203 89 182 132 165 107Z M191 28 L254 18 322 32 307 65 269 69 247 95 219 75 201 52Z M282 116 L317 107 337 132 311 146 290 139Z"
            />
          </svg>
          {safe.map((h, i) => (
            <div
              key={h.id}
              className={s.marker}
              style={{
                left: `${(h.longitude + 180) / 3.6}%`,
                top: `${(90 - h.latitude) / 1.8}%`,
              }}
            >
              <Button
                variant="secondary"
                excludeFromTabOrder={i !== Math.min(active, safe.length - 1)}
                onFocus={() => setActive(i)}
                onPress={() => onOpen(h.id)}
                onKeyDown={(event) => {
                  if (
                    [
                      "ArrowRight",
                      "ArrowDown",
                      "ArrowLeft",
                      "ArrowUp",
                      "Home",
                      "End",
                    ].includes(event.key)
                  ) {
                    event.preventDefault();
                    const next =
                      event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? safe.length - 1
                          : Math.max(
                              0,
                              Math.min(
                                safe.length - 1,
                                i +
                                  (["ArrowRight", "ArrowDown"].includes(
                                    event.key,
                                  )
                                    ? 1
                                    : -1),
                              ),
                            );
                    setActive(next);
                    ref.current
                      ?.querySelectorAll<HTMLButtonElement>("button")
                      [next]?.focus();
                  }
                }}
              >
                {h.label}
              </Button>
            </div>
          ))}
        </div>
      </div>
      <ul className={s.list}>
        {safe.map((h) => (
          <li className={s.panel} key={h.id}>
            <Button variant="secondary" onPress={() => onOpen(h.id)}>
              {h.label}
            </Button>
            <p>
              {h.territoryLabel} · {h.stateLabel} · {h.peeringLabel}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
