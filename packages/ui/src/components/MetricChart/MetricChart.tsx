import { t } from "../../i18n";
import { Link } from "../Link/Link";
import { countText, type DisplayCount } from "./values";
import s from "../DataTable/console.module.css";
export type MetricPoint = { id: string; label: string; value: DisplayCount };
export function MetricChart({
  label,
  period,
  definitionHref,
  points,
}: {
  label: string;
  period: string;
  definitionHref: string;
  points: readonly MetricPoint[];
}) {
  const max = Math.max(
    1,
    ...points.flatMap((p) =>
      p.value.kind === "value" ? [Math.abs(p.value.value)] : [],
    ),
  );
  return (
    <section className={s.stack} aria-label={label}>
      <h2>{label}</h2>
      <p>{period}</p>
      <Link href={definitionHref}>{t("consoleKit.definition")}</Link>
      <div className={s.chart} aria-hidden="true">
        {points.map((p) => (
          <div key={p.id}>
            <p>
              {p.label}: {countText(p.value)}
            </p>
            {p.value.kind === "value" && (
              <div
                className={s.bar}
                style={{ width: `${(Math.abs(p.value.value) / max) * 100}%` }}
              />
            )}
          </div>
        ))}
      </div>
      <table className={s.table}>
        <caption>
          {label} · {period}
        </caption>
        <thead>
          <tr>
            <th scope="col">{t("consoleKit.name")}</th>
            <th scope="col">{t("consoleKit.value")}</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.id}>
              <th scope="row">{p.label}</th>
              <td>{countText(p.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
