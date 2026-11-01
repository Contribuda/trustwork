import { useState, type ReactNode, type KeyboardEvent } from "react";
import type { SortDescriptor, Key } from "react-aria-components";
import { cx } from "../../utils/cx";
import { t, formatNumber } from "../../i18n";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { Button } from "../Button/Button";
import { Checkbox } from "../Choice/Choice";
import { Select } from "../Select/Select";
import { TextField } from "../TextField/TextField";
import { Skeleton, SkeletonGroup } from "../Skeleton/Skeleton";
import { EmptyState } from "../EmptyState/EmptyState";
import { VisuallyHidden } from "../VisuallyHidden/VisuallyHidden";
import { Pagination } from "../Pagination/Pagination";
import { FilterBar, type FilterBarProps } from "../FilterBar/FilterBar";
import { useGrid } from "./grid";
import { rowSelected, toggleRows, type TableSelection } from "./selection";
import styles from "./DataTable.module.css";
import s from "./console.module.css";

export type DataTableColumn<Row extends object> = {
  id: string;
  header: string;
  cell: (row: Row) => ReactNode;
  sortable?: boolean | undefined;
  align?: "start" | "end" | undefined;
  isRowHeader?: boolean | undefined;
  width?: number | undefined;
  /** Editing requests a change; it never mutates the supplied row. */
  edit?:
    | {
        value: (row: Row) => string;
        onCommit: (row: Row, value: string) => void;
      }
    | undefined;
};
export type DataTableProps<Row extends object> = {
  caption: string;
  hideCaption?: boolean | undefined;
  columns: readonly DataTableColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => Key;
  sort?: SortDescriptor | undefined;
  onSortChange?: ((descriptor: SortDescriptor) => void) | undefined;
  rowActions?: ((row: Row) => ReactNode) | undefined;
  state?: "idle" | "loading" | "error" | undefined;
  emptyTitle?: string | undefined;
  emptyBody?: ReactNode;
  errorAction?: ReactNode;
  layout?: "auto" | "table" | "cards" | undefined;
  className?: string | undefined;
  /** Table is the default. Only editable/interactive cells opt into the APG grid. */
  mode?: "table" | "grid" | undefined;
  /** In server mode every query/sort/page remains controlled; rows are never processed locally. */
  server?: boolean | undefined;
  filter?: FilterBarProps | undefined;
  pagination?:
    | {
        page: number;
        pageCount: number;
        total: number;
        onPageChange: (page: number) => void;
      }
    | undefined;
  selection?:
    | {
        value: TableSelection;
        onChange: (value: TableSelection) => void;
        rowLabel: (row: Row) => string;
        matching?: { snapshot: string; total: number };
      }
    | undefined;
  visibleColumns?: readonly string[] | undefined;
  onVisibleColumnsChange?: ((ids: string[]) => void) | undefined;
  columnOrder?: readonly string[] | undefined;
  onColumnOrderChange?: ((ids: string[]) => void) | undefined;
  density?: "comfortable" | "compact" | undefined;
  onDensityChange?: ((density: "comfortable" | "compact") => void) | undefined;
  savedViews?: ReactNode;
};
export function DataTable<Row extends object>({
  caption,
  hideCaption = false,
  columns,
  rows,
  rowKey,
  sort,
  onSortChange,
  rowActions,
  state = "idle",
  emptyTitle,
  emptyBody,
  errorAction,
  layout = "auto",
  className,
  mode = "table",
  server = false,
  filter,
  pagination,
  selection,
  visibleColumns,
  onVisibleColumnsChange,
  columnOrder,
  onColumnOrderChange,
  density = "comfortable",
  onDensityChange,
  savedViews,
}: DataTableProps<Row>) {
  const isMobile = useIsMobile();
  const asCards =
    mode !== "grid" && (layout === "cards" || (layout === "auto" && isMobile));
  const [internalSort, setInternalSort] = useState<SortDescriptor>();
  const [editing, setEditing] = useState<{
    key: Key;
    column: string;
    value: string;
  }>();
  const [notice, setNotice] = useState("");
  const activeSort = server ? sort : (sort ?? internalSort);
  const ordered = [...columns].sort((a, b) => {
    const index = (id: string) => {
      const n = columnOrder?.indexOf(id) ?? -1;
      return n < 0 ? columns.length : n;
    };
    return index(a.id) - index(b.id);
  });
  const shown = ordered.filter(
    (c) => !visibleColumns || visibleColumns.includes(c.id),
  );
  const grid = useGrid(
    rows.length + 1,
    shown.length + (selection ? 1 : 0) + (rowActions ? 1 : 0),
    mode === "grid",
  );
  const snapshot = selection?.matching?.snapshot;
  const keys = rows.map(rowKey);
  const selectedCount = !selection
    ? 0
    : selection.value.kind === "keys"
      ? selection.value.keys.size
      : selection.value.snapshot === snapshot
        ? Math.max(
            0,
            (selection.matching?.total ?? 0) - selection.value.excluded.size,
          )
        : 0;
  const total = pagination?.total ?? selection?.matching?.total ?? rows.length;
  const selected = (row: Row) =>
    !!selection && rowSelected(selection.value, rowKey(row), snapshot);
  const select = (row: Row) =>
    selection && (
      <Checkbox
        isSelected={selected(row)}
        onChange={(value) =>
          selection.onChange(
            toggleRows(selection.value, [rowKey(row)], value, snapshot),
          )
        }
      >
        {t("consoleKit.selectRow", { label: selection.rowLabel(row) })}
      </Checkbox>
    );
  function changeSort(c: DataTableColumn<Row>) {
    const next: SortDescriptor = {
      column: c.id,
      direction:
        activeSort?.column === c.id && activeSort.direction === "ascending"
          ? "descending"
          : "ascending",
    };
    if (!server) setInternalSort(next);
    onSortChange?.(next);
  }
  function finish(
    row: Row,
    c: DataTableColumn<Row>,
    save: boolean,
    r: number,
    col: number,
  ) {
    if (save && editing) {
      c.edit?.onCommit(row, editing.value);
      setNotice(t("consoleKit.saved"));
    }
    setEditing(undefined);
    grid.focus({ row: r, column: col });
  }
  function editKey(
    event: KeyboardEvent<HTMLElement>,
    row: Row,
    c: DataTableColumn<Row>,
  ) {
    if (
      event.target === event.currentTarget &&
      c.edit &&
      ["Enter", "F2"].includes(event.key)
    ) {
      event.preventDefault();
      setEditing({ key: rowKey(row), column: c.id, value: c.edit.value(row) });
    }
  }
  const content =
    state === "loading" ? (
      <SkeletonGroup label={t("table.loading")}>
        <Skeleton variant="table" lines={4} />
      </SkeletonGroup>
    ) : state === "error" ? (
      <EmptyState tone="error" title={t("table.error")} actions={errorAction} />
    ) : !rows.length ? (
      <EmptyState title={emptyTitle ?? t("table.empty")}>
        {emptyBody}
      </EmptyState>
    ) : asCards ? (
      <div className={styles.cards}>
        {!hideCaption && <p className={styles.caption}>{caption}</p>}
        <ul className={styles.cardList} aria-label={caption}>
          {rows.map((row) => (
            <li key={rowKey(row)} className={styles.card}>
              {select(row)}
              <dl className={styles.cardFields}>
                {shown.map((c) => (
                  <div key={c.id} className={styles.cardField}>
                    <dt>{c.header}</dt>
                    <dd>{c.cell(row)}</dd>
                  </div>
                ))}
              </dl>
              {rowActions && (
                <div className={styles.cardActions}>{rowActions(row)}</div>
              )}
            </li>
          ))}
        </ul>
      </div>
    ) : (
      <div
        role="region"
        aria-label={t("table.regionLabel", { caption })}
        tabIndex={0}
        className={styles.region}
      >
        <table
          ref={grid.ref}
          role={mode === "grid" ? "grid" : undefined}
          aria-label={caption}
          className={cx(s.table, styles.consoleTable)}
          data-density={density}
        >
          {!hideCaption && <caption>{caption}</caption>}
          <thead>
            <tr>
              {selection && (
                <th scope="col" {...(mode === "grid" ? grid.cell(0, 0) : {})}>
                  {t("consoleKit.selected", {
                    count: formatNumber(selectedCount),
                    total: formatNumber(total),
                  })}
                </th>
              )}
              {shown.map((c, col) => (
                <th
                  key={c.id}
                  scope="col"
                  aria-sort={
                    activeSort?.column === c.id
                      ? activeSort.direction
                      : undefined
                  }
                  {...(mode === "grid"
                    ? grid.cell(0, col + (selection ? 1 : 0))
                    : {})}
                  onClick={c.sortable ? () => changeSort(c) : undefined}
                  onKeyDown={(event) => {
                    if (mode === "grid")
                      grid.cell(0, col + (selection ? 1 : 0)).onKeyDown(event);
                    if (
                      event.target === event.currentTarget &&
                      c.sortable &&
                      ["Enter", " "].includes(event.key)
                    ) {
                      event.preventDefault();
                      changeSort(c);
                    }
                  }}
                >
                  {c.sortable ? (
                    <Button
                      variant="ghost"
                      excludeFromTabOrder={mode === "grid"}
                      onPress={() => changeSort(c)}
                      onClick={(event) => event.stopPropagation()}
                    >
                      {c.header}
                      <span aria-hidden="true">
                        {activeSort?.column === c.id
                          ? activeSort.direction === "ascending"
                            ? " ↑"
                            : " ↓"
                          : " ↕"}
                      </span>
                    </Button>
                  ) : (
                    c.header
                  )}
                </th>
              ))}
              {rowActions && (
                <th
                  scope="col"
                  {...(mode === "grid"
                    ? grid.cell(0, shown.length + (selection ? 1 : 0))
                    : {})}
                >
                  {t("table.rowActions")}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr
                key={rowKey(row)}
                aria-selected={
                  mode === "grid" && selection ? selected(row) : undefined
                }
              >
                {selection && (
                  <td {...(mode === "grid" ? grid.cell(r + 1, 0) : {})}>
                    {select(row)}
                  </td>
                )}
                {shown.map((c, index) => {
                  const col = index + (selection ? 1 : 0);
                  const isEditing =
                    editing?.key === rowKey(row) && editing.column === c.id;
                  const Tag =
                    mode === "table" && (c.isRowHeader ?? index === 0)
                      ? "th"
                      : "td";
                  return (
                    <Tag
                      key={c.id}
                      scope={Tag === "th" ? "row" : undefined}
                      role={mode === "grid" ? "gridcell" : undefined}
                      aria-readonly={mode === "grid" ? !c.edit : undefined}
                      {...(mode === "grid" ? grid.cell(r + 1, col) : {})}
                      onKeyDown={(event) => {
                        if (mode === "grid") {
                          grid.cell(r + 1, col).onKeyDown(event);
                          editKey(event, row, c);
                        }
                      }}
                      onDoubleClick={() => {
                        if (mode === "grid" && c.edit)
                          setEditing({
                            key: rowKey(row),
                            column: c.id,
                            value: c.edit.value(row),
                          });
                      }}
                      style={{
                        textAlign: c.align === "end" ? "end" : "start",
                        width: c.width,
                      }}
                    >
                      {isEditing ? (
                        <TextField
                          label={c.header}
                          value={editing.value}
                          autoFocus
                          onChange={(value) =>
                            setEditing({ ...editing, value })
                          }
                          onKeyDown={(event) => {
                            if (
                              ["Enter", "Escape", "Tab"].includes(event.key)
                            ) {
                              event.preventDefault();
                              event.stopPropagation();
                              finish(
                                row,
                                c,
                                event.key !== "Escape",
                                r + 1,
                                col,
                              );
                              if (event.key === "Tab")
                                grid.focus({
                                  row: r + 1,
                                  column: Math.max(
                                    0,
                                    Math.min(
                                      shown.length - 1,
                                      col + (event.shiftKey ? -1 : 1),
                                    ),
                                  ),
                                });
                            }
                          }}
                          onBlur={() => setEditing(undefined)}
                        />
                      ) : (
                        c.cell(row)
                      )}
                    </Tag>
                  );
                })}
                {rowActions && (
                  <td
                    {...(mode === "grid"
                      ? grid.cell(r + 1, shown.length + (selection ? 1 : 0))
                      : {})}
                  >
                    {rowActions(row)}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        <p className={styles.scrollHint}>{t("common.tableScrollHint")}</p>
      </div>
    );
  return (
    <div className={cx(s.stack, className)}>
      {savedViews}
      {filter && <FilterBar {...filter} />}
      <div className={s.row}>
        {asCards && shown.some((c) => c.sortable) && (
          <Select
            label={t("common.sortNone")}
            options={shown
              .filter((c) => c.sortable)
              .flatMap((c) =>
                (["ascending", "descending"] as const).map((direction) => ({
                  id: `${c.id}:${direction}`,
                  label: `${c.header} · ${t(direction === "ascending" ? "common.sortAscending" : "common.sortDescending")}`,
                })),
              )}
            selectedKey={
              activeSort ? `${activeSort.column}:${activeSort.direction}` : null
            }
            onSelectionChange={(key) => {
              const [column, direction] = String(key).split(":");
              const next: SortDescriptor = {
                column: column!,
                direction:
                  direction === "descending" ? "descending" : "ascending",
              };
              if (!server) setInternalSort(next);
              onSortChange?.(next);
            }}
          />
        )}
        {onVisibleColumnsChange && (
          <details>
            <summary>{t("consoleKit.columns")}</summary>
            {ordered.map((c) => (
              <div key={c.id} className={s.row}>
                <Checkbox
                  isSelected={shown.includes(c)}
                  isDisabled={shown.length === 1 && shown.includes(c)}
                  onChange={(checked) =>
                    onVisibleColumnsChange(
                      checked
                        ? [...shown.map((c) => c.id), c.id]
                        : shown.filter((x) => x.id !== c.id).map((x) => x.id),
                    )
                  }
                >
                  {c.header}
                </Checkbox>
                {onColumnOrderChange &&
                  ([-1, 1] as const).map((offset) => {
                    const index = ordered.indexOf(c);
                    return (
                      <Button
                        key={offset}
                        variant="ghost"
                        isDisabled={
                          index + offset < 0 || index + offset >= ordered.length
                        }
                        onPress={() => {
                          const next = ordered.map((c) => c.id);
                          [next[index], next[index + offset]] = [
                            next[index + offset]!,
                            next[index]!,
                          ];
                          onColumnOrderChange(next);
                          setNotice(t("consoleKit.columnMoved"));
                        }}
                      >
                        {t(
                          offset === -1
                            ? "consoleKit.moveUp"
                            : "consoleKit.moveDown",
                          { label: c.header },
                        )}
                      </Button>
                    );
                  })}
              </div>
            ))}
          </details>
        )}
        {onDensityChange && (
          <Select
            label={t("consoleKit.density")}
            selectedKey={density}
            onSelectionChange={(key) =>
              onDensityChange(key === "compact" ? "compact" : "comfortable")
            }
            options={(["comfortable", "compact"] as const).map((id) => ({
              id,
              label: t(`consoleKit.${id}`),
            }))}
          />
        )}
        {selection && (
          <>
            <Checkbox
              isSelected={!!rows.length && rows.every(selected)}
              isIndeterminate={rows.some(selected) && !rows.every(selected)}
              onChange={(checked) =>
                selection.onChange(
                  toggleRows(selection.value, keys, checked, snapshot),
                )
              }
            >
              {t("consoleKit.selectPage")}
            </Checkbox>
            {selection.matching && (
              <Button
                variant="secondary"
                onPress={() =>
                  selection.onChange({
                    kind: "matching",
                    snapshot: selection.matching!.snapshot,
                    excluded: new Set(),
                  })
                }
              >
                {t("consoleKit.selectAll", {
                  count: formatNumber(selection.matching.total),
                })}
              </Button>
            )}
          </>
        )}
      </div>
      {mode === "grid" && (
        <p className={s.muted}>
          {t("consoleKit.editHint", {
            enter: "Enter",
            edit: "F2",
            escape: "Escape",
          })}
        </p>
      )}
      {content}
      <p role="status" aria-live="polite" aria-atomic="true">
        {selection
          ? t("consoleKit.selected", {
              count: formatNumber(selectedCount),
              total: formatNumber(total),
            })
          : t("consoleKit.results", { count: formatNumber(total) })}
      </p>
      <VisuallyHidden>
        <span role="status">{notice}</span>
      </VisuallyHidden>
      {pagination && (
        <Pagination
          page={pagination.page}
          pageCount={pagination.pageCount}
          onPageChange={pagination.onPageChange}
          isLoading={state === "loading"}
        />
      )}
    </div>
  );
}
export type { TableSelection } from "./selection";
