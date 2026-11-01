import { t } from "../../i18n";
import { StatusChip, type StatusTone } from "../Badge/Badge";
export type ConsoleStatus =
  "live" | "demo" | "contract" | "designed" | "proposed" | "fake" | "manual";
/** Promoted administrative status chip. Domain-specific run states use RunStatusBadge. */
export function StatusLabel({
  status,
  label,
  tone,
}: {
  status: ConsoleStatus;
  label?: string | undefined;
  tone?: StatusTone | undefined;
}) {
  return (
    <StatusChip
      size="sm"
      tone={
        tone ??
        (status === "live" ? "success" : status === "demo" ? "info" : "neutral")
      }
    >
      {label ?? t(`consoleKit.statuses.${status}`)}
    </StatusChip>
  );
}
