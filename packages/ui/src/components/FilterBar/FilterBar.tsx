import type { ReactNode } from "react";
import { t, formatNumber } from "../../i18n";
import { TextField } from "../TextField/TextField";
import { Button } from "../Button/Button";
import { RemovableTag } from "../TagSelect/TagSelect";
import s from "../DataTable/console.module.css";

export type FilterChip = { id: string; label: string };
export type FilterBarProps = {
  query: string;
  onQueryChange: (query: string) => void;
  filters: readonly FilterChip[];
  onRemove: (id: string) => void;
  onClear: () => void;
  resultCount: number;
  children?: ReactNode;
  isLoading?: boolean | undefined;
};
/** Requests a query; never filters a server result page locally. */
export function FilterBar({
  query,
  onQueryChange,
  filters,
  onRemove,
  onClear,
  resultCount,
  children,
  isLoading,
}: FilterBarProps) {
  return (
    <section
      aria-label={t("consoleKit.filters")}
      className={s.stack}
      aria-busy={isLoading}
    >
      <div className={s.row}>
        <TextField
          type="search"
          label={t("consoleKit.search")}
          value={query}
          onChange={onQueryChange}
        />
        {children}
        <Button
          variant="secondary"
          onPress={onClear}
          isDisabled={!query && !filters.length}
        >
          {t("consoleKit.clear")}
        </Button>
      </div>
      <ul className={s.row}>
        {filters.map((f) => (
          <li key={f.id}>
            <RemovableTag label={f.label} onRemove={() => onRemove(f.id)} />
          </li>
        ))}
      </ul>
      <p role="status" aria-live="polite" aria-atomic="true">
        {t("consoleKit.filterCount", { count: formatNumber(filters.length) })}.{" "}
        {t("consoleKit.results", { count: formatNumber(resultCount) })}
      </p>
    </section>
  );
}
