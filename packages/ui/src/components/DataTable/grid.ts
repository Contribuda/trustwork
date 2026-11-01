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
/** Interaction Tab order includes headers, selection and actions; outer bounds exit. */
export function gridTabDestination(
  position: GridPosition,
  backwards: boolean,
  rows: number,
  columns: number,
): GridPosition | undefined {
  const index = position.row * columns + position.column + (backwards ? -1 : 1);
  if (index < 0 || index >= rows * columns) return undefined;
  return { row: Math.floor(index / columns), column: index % columns };
}
const controlSelector =
  'button, input:not([type="hidden"]), a[href], textarea, select, [contenteditable="true"], [tabindex]:not([data-grid-row])';
function controls(cell: HTMLElement) {
  return [...cell.querySelectorAll<HTMLElement>(controlSelector)].filter(
    (element) =>
      !element.matches(':disabled, [aria-disabled="true"]') &&
      !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== "hidden",
  );
}
export function useGrid(rows: number, columns: number, enabled = true) {
  const ref = useRef<HTMLTableElement>(null);
  const [position, setPosition] = useState<GridPosition>({ row: 0, column: 0 });
  const active = gridDestination(position, "", false, rows, columns);
  useLayoutEffect(() => {
    if (!enabled) return;
    // Only the active cell is in the page tab order. Interaction mode traverses
    // enabled descendants explicitly, including controls supplied by the caller.
    const previous = new Map<HTMLElement, string | null>();
    for (const cell of ref.current?.querySelectorAll<HTMLElement>(
      "[data-grid-row]",
    ) ?? [])
      for (const element of cell.querySelectorAll<HTMLElement>(
        controlSelector,
      )) {
        previous.set(element, element.getAttribute("tabindex"));
        element.tabIndex = -1;
      }
    return () => {
      for (const [element, value] of previous)
        if (value === null) element.removeAttribute("tabindex");
        else element.setAttribute("tabindex", value);
    };
  });
  function focus(next: GridPosition) {
    setPosition(next);
    ref.current
      ?.querySelector<HTMLElement>(
        `[data-grid-row="${next.row}"][data-grid-column="${next.column}"]`,
      )
      ?.focus();
  }
  function tab(event: KeyboardEvent<HTMLElement>, from: GridPosition) {
    const next = gridTabDestination(from, event.shiftKey, rows, columns);
    // Focus a stable cell before an editor unmounts. At the outer boundaries
    // the browser's default Tab leaves the grid in either direction.
    focus(next ?? from);
    if (next) event.preventDefault();
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
          if (event.key === "Tab") {
            const items = controls(event.currentTarget);
            const index = items.indexOf(event.target as HTMLElement);
            const next = items[index + (event.shiftKey ? -1 : 1)];
            if (index >= 0 && next) {
              event.preventDefault();
              next.focus();
            } else tab(event, { row, column });
            event.stopPropagation();
          }
          return;
        }
        if (["Enter", "F2"].includes(event.key)) {
          const control = controls(event.currentTarget)[0];
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
  return { ref, cell, focus, tab };
}
