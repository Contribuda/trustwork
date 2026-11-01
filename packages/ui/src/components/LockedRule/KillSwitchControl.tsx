import { t } from "../../i18n";
import { Button } from "../Button/Button";
import { ReasonField } from "../StepUpPrompt/ReasonField";
import { TextArea } from "../TextField/TextField";
import s from "../DataTable/console.module.css";
export type KillSwitchControlProps = {
  label: string;
  stateLabel: string;
  engaged: boolean;
  reason: string;
  onReasonChange: (value: string) => void;
  incident: string;
  onIncidentChange: (value: string) => void;
  onEngage: () => void;
  onRequestRelease: () => void;
  disabledReason?: string | undefined;
  pending?: boolean | undefined;
};
/** Release requests remain requests; the caller owns the second-person workflow. */
export function KillSwitchControl(p: KillSwitchControlProps) {
  return (
    <section className={s.panel} aria-label={p.label}>
      <h2>{p.label}</h2>
      <p role="status">{p.stateLabel}</p>
      <ReasonField value={p.reason} onChange={p.onReasonChange} />
      {p.engaged && (
        <TextArea
          label={t("consoleKit.incident")}
          value={p.incident}
          onChange={p.onIncidentChange}
          isRequired
        />
      )}
      <Button
        variant={p.engaged ? "secondary" : "danger"}
        isLoading={p.pending}
        isDisabled={
          !!p.disabledReason ||
          !p.reason.trim() ||
          (p.engaged && !p.incident.trim())
        }
        onPress={p.engaged ? p.onRequestRelease : p.onEngage}
      >
        {t(p.engaged ? "consoleKit.release" : "consoleKit.engage")}
      </Button>
      {p.disabledReason && <p>{p.disabledReason}</p>}
    </section>
  );
}
