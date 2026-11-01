import { useState } from "react";
import { Button } from "../Button/Button";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { useGrid } from "../DataTable/grid";
import s from "../DataTable/console.module.css";
export type PermissionCell = {
  label: string;
  explanation: string;
  onPress?: (() => void) | undefined;
};
export type PermissionMatrixProps = {
  label: string;
  roles: readonly { id: string; label: string }[];
  permissions: readonly {
    id: string;
    label: string;
    cells: Readonly<Record<string, PermissionCell>>;
  }[];
};
/** A read model with interactive explanations, not a role editor or policy evaluator. */
export function PermissionMatrix({
  label,
  roles,
  permissions,
}: PermissionMatrixProps) {
  const mobile = useIsMobile();
  const grid = useGrid(permissions.length + 1, roles.length + 1);
  const [explanation, setExplanation] = useState("");
  function open(cell: PermissionCell) {
    setExplanation(cell.explanation);
    cell.onPress?.();
  }
  return (
    <div className={s.stack}>
      {mobile ? (
        <ul aria-label={label} className={s.list}>
          {permissions.map((p) => (
            <li key={p.id} className={s.panel}>
              <h3>{p.label}</h3>
              <code>{p.id}</code>
              {roles.map((r) => {
                const c = p.cells[r.id];
                return (
                  c && (
                    <p key={r.id}>
                      <Button variant="secondary" onPress={() => open(c)}>
                        {r.label}: {c.label}
                      </Button>
                    </p>
                  )
                );
              })}
            </li>
          ))}
        </ul>
      ) : (
        <div className={s.scroll}>
          <table
            ref={grid.ref}
            role="grid"
            aria-label={label}
            className={s.table}
          >
            <thead>
              <tr>
                <th scope="col" {...grid.cell(0, 0)}>
                  {label}
                </th>
                {roles.map((r, i) => (
                  <th scope="col" key={r.id} {...grid.cell(0, i + 1)}>
                    {r.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {permissions.map((p, row) => (
                <tr key={p.id}>
                  <th scope="row" {...grid.cell(row + 1, 0)}>
                    {p.label}
                    <p>
                      <code>{p.id}</code>
                    </p>
                  </th>
                  {roles.map((r, column) => {
                    const cell = p.cells[r.id];
                    const props = grid.cell(row + 1, column + 1);
                    return (
                      <td
                        key={r.id}
                        role="gridcell"
                        {...props}
                        onFocus={() => {
                          props.onFocus();
                          setExplanation(cell?.explanation ?? "");
                        }}
                        onClick={() => {
                          if (cell) open(cell);
                        }}
                        onKeyDown={(event) => {
                          props.onKeyDown(event);
                          if (cell && ["Enter", " "].includes(event.key)) {
                            event.preventDefault();
                            open(cell);
                          }
                        }}
                      >
                        {cell?.label}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p role="status" aria-live="polite">
        {explanation}
      </p>
    </div>
  );
}
