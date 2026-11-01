import { useState, type ReactNode } from "react";
import { t } from "../../i18n";
import { Checkbox } from "../Choice/Choice";
import s from "../DataTable/console.module.css";
export type DiffField = {
  id: string;
  label: string;
  kind: "added" | "removed" | "changed" | "unchanged";
  before: ReactNode;
  after: ReactNode;
  effect: string;
};
export function DiffViewer({
  label,
  fields,
}: {
  label: string;
  fields: readonly DiffField[];
}) {
  const [show, setShow] = useState(false);
  return (
    <div className={s.stack}>
      <Checkbox isSelected={show} onChange={setShow}>
        {t("consoleKit.showUnchanged")}
      </Checkbox>
      <div className={s.scroll} tabIndex={0} role="region" aria-label={label}>
        <table className={`${s.table} ${s.diffTable}`}>
          <caption>{label}</caption>
          <thead>
            <tr>
              <th scope="col">{t("consoleKit.field")}</th>
              <th scope="col">{t("consoleKit.before")}</th>
              <th scope="col">{t("consoleKit.after")}</th>
            </tr>
          </thead>
          <tbody>
            {fields
              .filter((f) => show || f.kind !== "unchanged")
              .map((f) => (
                <tr key={f.id}>
                  <th scope="row">
                    {f.label}
                    <p>{t(`consoleKit.${f.kind}`)}</p>
                    <p className={s.muted}>{f.effect}</p>
                  </th>
                  <td>{f.before}</td>
                  <td>{f.after}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <p className={s.muted}>{t("common.tableScrollHint")}</p>
    </div>
  );
}
