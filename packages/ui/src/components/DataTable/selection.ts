import type { Key } from "react-aria-components";
/** All-matching selections are explicitly bound to the caller's immutable query snapshot. */
export type TableSelection =
  | { kind: "keys"; keys: ReadonlySet<Key> }
  | { kind: "matching"; snapshot: string; excluded: ReadonlySet<Key> };
export function rowSelected(
  selection: TableSelection,
  key: Key,
  snapshot?: string,
): boolean {
  return selection.kind === "keys"
    ? selection.keys.has(key)
    : selection.snapshot === snapshot && !selection.excluded.has(key);
}
export function toggleRows(
  selection: TableSelection,
  keys: readonly Key[],
  selected: boolean,
  snapshot?: string,
): TableSelection {
  if (selection.kind === "matching" && selection.snapshot === snapshot) {
    const excluded = new Set(selection.excluded);
    for (const key of keys) {
      if (selected) excluded.delete(key);
      else excluded.add(key);
    }
    return { ...selection, excluded };
  }
  const next = new Set(selection.kind === "keys" ? selection.keys : []);
  for (const key of keys) {
    if (selected) next.add(key);
    else next.delete(key);
  }
  return { kind: "keys", keys: next };
}
