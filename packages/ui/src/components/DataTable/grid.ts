import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
export type GridPosition = { row: number; column: number };
/** APG data-grid navigation, clamped to existing cells, without wrapping. */
export function gridDestination(
  position: GridPosition,
  key: string,
  ctrl: boolean,
  rows: number,
  columns: number,
): GridPosition {
  let { row, column } = position;
  if (key === "ArrowDown") row++;
  if (key === "ArrowUp") row--;
  if (key === "ArrowRight") column++;
  if (key === "ArrowLeft") column--;
  if (key === "Home") {
    column = 0;
    if (ctrl) row = 0;
  }
  if (key === "End") {
    column = columns - 1;
    if (ctrl) row = rows - 1;
  }
  if (key === "PageDown") row += 5;
  if (key === "PageUp") row -= 5;
  return {
    row: Math.max(0, Math.min(rows - 1, row)),
    column: Math.max(0, Math.min(columns - 1, column)),
  };
}
export function useGrid(rows: number, columns: number, enabled = true) {
  const ref = useRef<HTMLTableElement>(null);
  const [position, setPosition] = useState<GridPosition>({ row: 0, column: 0 });
  const active = gridDestination(position, "", false, rows, columns);
  useLayoutEffect(() => {
    if (!enabled) return;
    // The grid is one tab stop. Enter/F2 enters a cell control, Escape returns to navigation.
    for (const element of ref.current?.querySelectorAll<HTMLElement>(
      "[data-grid-row] button, [data-grid-row] input, [data-grid-row] a, [data-grid-row] textarea, [data-grid-row] select",
    ) ?? [])
      element.tabIndex = -1;
  });
  function focus(next: GridPosition) {
    setPosition(next);
    ref.current
      ?.querySelector<HTMLElement>(
        `[data-grid-row="${next.row}"][data-grid-column="${next.column}"]`,
      )
      ?.focus();
  }
  function cell(row: number, column: number) {
    return {
      "data-grid-row": row,
      "data-grid-column": column,
      tabIndex: active.row === row && active.column === column ? 0 : -1,
      onFocus: () => setPosition({ row, column }),
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        if (event.target !== event.currentTarget) {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            focus({ row, column });
          }
          return;
        }
        if (["Enter", "F2"].includes(event.key)) {
          const control = event.currentTarget.querySelector<HTMLElement>(
            "button, input, a, textarea, select",
          );
          if (control) {
            event.preventDefault();
            control.focus();
          }
          return;
        }
        if (
          ![
            "ArrowDown",
            "ArrowUp",
            "ArrowLeft",
            "ArrowRight",
            "Home",
            "End",
            "PageDown",
            "PageUp",
          ].includes(event.key)
        )
          return;
        event.preventDefault();
        focus(
          gridDestination(
            { row, column },
            event.key,
            event.ctrlKey || event.metaKey,
            rows,
            columns,
          ),
        );
      },
    };
  }
  return { ref, cell, focus };
}
