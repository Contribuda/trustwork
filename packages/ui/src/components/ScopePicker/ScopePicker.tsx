import { t } from "../../i18n";
import { Radio, RadioGroup } from "../Choice/Choice";
import { ComboBox } from "../Select/Select";
import s from "../DataTable/console.module.css";
export type StaffScopeOption = {
  id: string;
  kind: "platform" | "node" | "hub";
  label: string;
};
export type ScopePickerProps = {
  options: readonly StaffScopeOption[];
  kind: StaffScopeOption["kind"];
  selectedId: string | null;
  onKindChange: (kind: StaffScopeOption["kind"]) => void;
  onChange: (id: string | null) => void;
  explanation: string;
};
/** Assignment-form scope only. Supply the server-filtered role/assigner intersection, never participant identities. */
export function ScopePicker(p: ScopePickerProps) {
  const kinds = (["platform", "node", "hub"] as const).filter((k) =>
    p.options.some((o) => o.kind === k),
  );
  return (
    <div className={s.stack}>
      <RadioGroup
        label={t("consoleKit.scope")}
        description={p.explanation}
        value={p.kind}
        onChange={(value) => {
          if (kinds.includes(value as StaffScopeOption["kind"]))
            p.onKindChange(value as StaffScopeOption["kind"]);
        }}
      >
        {kinds.map((k) => (
          <Radio key={k} value={k}>
            {t(`consoleKit.${k}`)}
          </Radio>
        ))}
      </RadioGroup>
      <ComboBox
        label={t(`consoleKit.${p.kind}`)}
        options={p.options.filter((o) => o.kind === p.kind)}
        selectedKey={
          p.options.some((o) => o.id === p.selectedId && o.kind === p.kind)
            ? p.selectedId
            : null
        }
        onSelectionChange={(key) =>
          p.onChange(key === null ? null : String(key))
        }
      />
    </div>
  );
}
