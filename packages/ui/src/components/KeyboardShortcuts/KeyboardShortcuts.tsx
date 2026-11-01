import { t } from "../../i18n";
import { Dialog } from "../Dialog/Dialog";
import { Checkbox } from "../Choice/Choice";
import s from "../DataTable/console.module.css";
export type KeyboardShortcut = {
  id: string;
  keys: string;
  description: string;
};
/** The application owns and persists this preference and applies it when dispatching shortcuts. */
export function KeyboardShortcuts({
  isOpen,
  onOpenChange,
  shortcuts,
  singleKeysEnabled,
  onSingleKeysChange,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  shortcuts: readonly KeyboardShortcut[];
  singleKeysEnabled: boolean;
  onSingleKeysChange: (enabled: boolean) => void;
}) {
  return (
    <Dialog
      title={t("consoleKit.shortcuts")}
      isOpen={isOpen}
      onOpenChange={onOpenChange}
    >
      <Checkbox isSelected={singleKeysEnabled} onChange={onSingleKeysChange}>
        {t("consoleKit.singleKeys")}
      </Checkbox>
      <table className={s.table}>
        <caption>{t("consoleKit.shortcuts")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("consoleKit.keys")}</th>
            <th scope="col">{t("table.rowActions")}</th>
          </tr>
        </thead>
        <tbody>
          {shortcuts.map((x) => (
            <tr key={x.id}>
              <th scope="row">
                <kbd>{x.keys}</kbd>
              </th>
              <td>{x.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
}
