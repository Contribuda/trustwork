import { Checkbox } from "../Choice/Choice";
import { CohortCount, type DisplayCount } from "../MetricChart/values";
import s from "../DataTable/console.module.css";
export type Facet = {
  id: string;
  label: string;
  options: readonly {
    id: string;
    label: string;
    count: DisplayCount;
    disabled?: boolean;
  }[];
};
export type FacetPanelProps = {
  facets: readonly Facet[];
  selected: Readonly<Record<string, readonly string[]>>;
  onChange: (facet: string, values: string[]) => void;
};
export function FacetPanel({ facets, selected, onChange }: FacetPanelProps) {
  return (
    <div className={s.stack}>
      {facets.map((f) => (
        <fieldset key={f.id} className={s.panel}>
          <legend>{f.label}</legend>
          {f.options.map((o) => (
            <Checkbox
              key={o.id}
              isDisabled={o.disabled ?? false}
              isSelected={(selected[f.id] ?? []).includes(o.id)}
              onChange={(checked) =>
                onChange(
                  f.id,
                  checked
                    ? [...(selected[f.id] ?? []), o.id]
                    : (selected[f.id] ?? []).filter((id) => id !== o.id),
                )
              }
            >
              {o.label} (<CohortCount value={o.count} />)
            </Checkbox>
          ))}
        </fieldset>
      ))}
    </div>
  );
}
