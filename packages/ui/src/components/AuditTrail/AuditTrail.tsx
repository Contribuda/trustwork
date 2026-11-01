import { intlTag } from "../../i18n";
import type { ReactNode } from "react";
import s from "../DataTable/console.module.css";
export function ConsoleTime({
  value,
  timeZone,
}: {
  value: string;
  timeZone: string;
}) {
  return (
    <time dateTime={value}>
      {new Intl.DateTimeFormat(intlTag(), {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone,
      }).format(new Date(value))}{" "}
      ({timeZone})
    </time>
  );
}
export type AuditEntry = {
  id: string;
  at: string;
  actorRole: string;
  action: string;
  reason: string;
  approval?: ReactNode;
  digest?: ReactNode;
};
export function AuditTrail({
  label,
  entries,
  timeZone,
}: {
  label: string;
  entries: readonly AuditEntry[];
  timeZone: string;
}) {
  return (
    <ol aria-label={label} className={s.list}>
      {entries.map((e) => (
        <li key={e.id} className={s.panel}>
          <ConsoleTime value={e.at} timeZone={timeZone} />
          <p>
            <strong>{e.action}</strong> · {e.actorRole}
          </p>
          <p>{e.reason}</p>
          {e.approval}
          {e.digest}
        </li>
      ))}
    </ol>
  );
}
