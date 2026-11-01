import { useState } from "react";
import type { SortDescriptor } from "react-aria-components";
import { t } from "../../i18n";
import { Button } from "../Button/Button";
import { Checkbox } from "../Choice/Choice";
import { TextField } from "../TextField/TextField";
import { Menu, MenuTrigger } from "../Menu/Menu";
import s from "../DataTable/console.module.css";
export type ViewConfiguration = {
  query: string;
  filters: Readonly<Record<string, readonly string[]>>;
  columns: readonly string[];
  sort?: SortDescriptor | undefined;
};
export type SavedView = {
  id: string;
  name: string;
  configuration: ViewConfiguration;
  shared: boolean;
  isDefault: boolean;
};
export type SavedViewsProps = {
  views: readonly SavedView[];
  selectedId: string | null;
  current: ViewConfiguration;
  onSelect: (id: string) => void;
  onSave: (view: {
    name: string;
    configuration: ViewConfiguration;
    shared: boolean;
    isDefault: boolean;
  }) => void;
  onShare: (id: string, shared: boolean) => void;
  onDefault: (id: string) => void;
  allowShare?: boolean | undefined;
};
export function SavedViews(p: SavedViewsProps) {
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [isDefault, setDefault] = useState(false);
  const current = p.views.find((v) => v.id === p.selectedId);
  return (
    <section className={s.stack} aria-label={t("consoleKit.views")}>
      <div className={s.row}>
        <MenuTrigger>
          <Button variant="secondary">
            {t("consoleKit.views")}
            {current ? `: ${current.name}` : ""}
          </Button>
          <Menu
            aria-label={t("consoleKit.views")}
            items={p.views.map((v) => ({ id: v.id, label: v.name }))}
            onAction={(id) => p.onSelect(String(id))}
          />
        </MenuTrigger>
        {current && (
          <>
            <Button
              variant="secondary"
              onPress={() => p.onDefault(current.id)}
              isDisabled={current.isDefault}
            >
              {t("consoleKit.defaultView")}
            </Button>
            {p.allowShare && (
              <Checkbox
                isSelected={current.shared}
                onChange={(value) => p.onShare(current.id, value)}
              >
                {t("consoleKit.share")}
              </Checkbox>
            )}
          </>
        )}
      </div>
      <form
        className={s.row}
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim())
            p.onSave({
              name: name.trim(),
              configuration: p.current,
              shared: !!p.allowShare && shared,
              isDefault,
            });
        }}
      >
        <TextField
          label={t("consoleKit.viewName")}
          value={name}
          onChange={setName}
          isRequired
        />
        {p.allowShare && (
          <Checkbox isSelected={shared} onChange={setShared}>
            {t("consoleKit.share")}
          </Checkbox>
        )}
        <Checkbox isSelected={isDefault} onChange={setDefault}>
          {t("consoleKit.defaultView")}
        </Checkbox>
        <Button type="submit" isDisabled={!name.trim()}>
          {t("consoleKit.saveView")}
        </Button>
      </form>
      <p role="status">{current?.name}</p>
    </section>
  );
}
