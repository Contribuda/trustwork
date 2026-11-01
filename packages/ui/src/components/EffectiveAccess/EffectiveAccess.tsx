import type { ReactNode } from "react";
import { ConsoleTime } from "../AuditTrail/AuditTrail";
import s from "../DataTable/console.module.css";
export type AccessGroup = {
  id: string;
  title: string;
  entries: readonly {
    id: string;
    permission: string;
    grantingRole: string;
    stateLabel: string;
    expiresAt?: string | undefined;
    explanation: ReactNode;
  }[];
};
/** Display an already projected access explanation; never calculate effective permissions in the browser. */
export function EffectiveAccess({
  groups,
  timeZone,
}: {
  groups: readonly AccessGroup[];
  timeZone: string;
}) {
  return (
    <div className={s.stack}>
      {groups.map((g) => (
        <section key={g.id} className={s.panel}>
          <h3>{g.title}</h3>
          <dl>
            {g.entries.map((e) => (
              <div key={e.id}>
                <dt>
                  <strong>{e.permission}</strong>
                </dt>
                <dd>
                  {e.grantingRole} · {e.stateLabel}
                  {e.expiresAt && (
                    <p>
                      <ConsoleTime value={e.expiresAt} timeZone={timeZone} />
                    </p>
                  )}
                  {e.explanation}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}
