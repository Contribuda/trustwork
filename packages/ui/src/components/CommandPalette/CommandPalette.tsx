import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { t, formatNumber } from "../../i18n";
import { Dialog } from "../Dialog/Dialog";
import s from "../DataTable/console.module.css";
export type PaletteCommand = {
  id: string;
  label: string;
  group: string;
  shortcut?: string | undefined;
  onSelect: () => void;
};
export type CommandPaletteProps = {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  onQueryChange: (value: string) => void;
  commands: readonly PaletteCommand[];
  enableShortcut?: boolean | undefined;
  isLoading?: boolean | undefined;
};
/** Results are supplied by the caller. Commands open a permitted destination/form; text is never authority. */
export function CommandPalette({
  isOpen,
  onOpenChange,
  query,
  onQueryChange,
  commands,
  enableShortcut = true,
  isLoading,
}: CommandPaletteProps) {
  const id = useId();
  const [active, setActive] = useState(0);
  const current = Math.min(active, Math.max(0, commands.length - 1));
  useEffect(() => {
    if (!enableShortcut) return;
    const key = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpenChange(!isOpen);
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [enableShortcut, isOpen, onOpenChange]);
  function choose(command: PaletteCommand) {
    onOpenChange(false);
    command.onSelect();
  }
  function navigate(event: KeyboardEvent<HTMLInputElement>) {
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      setActive(
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? commands.length - 1
            : Math.max(
                0,
                Math.min(
                  commands.length - 1,
                  current + (event.key === "ArrowDown" ? 1 : -1),
                ),
              ),
      );
    }
    if (event.key === "Enter" && commands[current]) {
      event.preventDefault();
      choose(commands[current]);
    }
  }
  useEffect(() => {
    if (isOpen)
      document
        .getElementById(`${id}-${current}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [id, current, isOpen]);
  const groups = [...new Set(commands.map((c) => c.group))];
  return (
    <Dialog
      title={t("consoleKit.commands")}
      isOpen={isOpen}
      onOpenChange={onOpenChange}
    >
      <div className={s.stack}>
        <label htmlFor={`${id}-input`}>{t("consoleKit.commands")}</label>
        <input
          className={s.commandInput}
          id={`${id}-input`}
          autoFocus
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={`${id}-results`}
          aria-activedescendant={
            commands[current] ? `${id}-${current}` : undefined
          }
          value={query}
          onChange={(event) => {
            setActive(0);
            onQueryChange(event.target.value);
          }}
          onKeyDown={navigate}
        />
        <div
          className={s.commandResults}
          role="listbox"
          id={`${id}-results`}
          aria-label={t("consoleKit.commands")}
          aria-busy={isLoading}
        >
          {groups.map((group, i) => (
            <div key={group} role="group" aria-labelledby={`${id}-group-${i}`}>
              <div
                role="presentation"
                aria-hidden="true"
                id={`${id}-group-${i}`}
              >
                {group}
              </div>
              {commands.map(
                (c, index) =>
                  c.group === group && (
                    <div
                      key={c.id}
                      id={`${id}-${index}`}
                      role="option"
                      aria-selected={current === index}
                      className={`${s.panel} ${s.commandOption}`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => choose(c)}
                    >
                      {c.label} {c.shortcut && <kbd>{c.shortcut}</kbd>}
                    </div>
                  ),
              )}
            </div>
          ))}
        </div>
        <p role="status" aria-live="polite">
          {isLoading
            ? t("common.loading")
            : commands.length
              ? t("consoleKit.results", {
                  count: formatNumber(commands.length),
                })
              : t("common.noResults")}
        </p>
      </div>
    </Dialog>
  );
}
