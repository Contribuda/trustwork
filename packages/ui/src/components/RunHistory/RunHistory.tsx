import type { ReactNode } from "react";
import { t } from "../../i18n";
import { ConsoleTime } from "../AuditTrail/AuditTrail";
import s from "../DataTable/console.module.css";
export type RunRecord = {
  id: string;
  label: string;
  at: string;
  stateLabel: string;
  dryRun: boolean;
  outcomeUnknown: boolean;
  steps: readonly {
    id: string;
    label: string;
    stateLabel: string;
    detail?: ReactNode;
  }[];
  actions?: ReactNode;
};
export function RunHistory({
  label,
  runs,
  timeZone,
}: {
  label: string;
  runs: readonly RunRecord[];
  timeZone: string;
}) {
  return (
    <ol className={s.list} aria-label={label}>
      {runs.map((run) => (
        <li key={run.id} className={s.panel}>
          <h3>{run.label}</h3>
          <ConsoleTime value={run.at} timeZone={timeZone} />
          <p>{run.stateLabel}</p>
          {run.dryRun && <p>{t("consoleKit.dryRun")}</p>}
          {run.outcomeUnknown && <p>{t("consoleKit.unknown")}</p>}
          <ol>
            {run.steps.map((step) => (
              <li key={step.id}>
                <strong>{step.label}</strong> · {step.stateLabel}
                {step.detail}
              </li>
            ))}
          </ol>
          {run.actions}
        </li>
      ))}
    </ol>
  );
}
