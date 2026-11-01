import type { ReactNode } from "react";
import { ConsoleTime } from "../AuditTrail/AuditTrail";
import { Link } from "../Link/Link";
import s from "../DataTable/console.module.css";
export type InboxItem = {
  id: string;
  title: string;
  href: string;
  kindLabel: string;
  stateLabel: string;
  reasonForAssignment: string;
  expiresAt?: string | undefined;
  actions?: ReactNode;
};
/** Structured work items only, not a participant correspondence inbox. */
export function InboxList({
  label,
  items,
  timeZone,
}: {
  label: string;
  items: readonly InboxItem[];
  timeZone: string;
}) {
  return (
    <ul aria-label={label} className={s.list}>
      {items.map((i) => (
        <li key={i.id}>
          <article className={s.panel}>
            <h3>
              <Link href={i.href}>{i.title}</Link>
            </h3>
            <p>
              {i.kindLabel} · {i.stateLabel}
            </p>
            <p>{i.reasonForAssignment}</p>
            {i.expiresAt && (
              <p>
                <ConsoleTime value={i.expiresAt} timeZone={timeZone} />
              </p>
            )}
            {i.actions}
          </article>
        </li>
      ))}
    </ul>
  );
}
