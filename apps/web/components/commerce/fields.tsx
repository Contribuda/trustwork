import type { ReactNode } from 'react';
import { t } from '@/app/_lib/i18n';
import { UNIT_OPTIONS } from './format';

/**
 * Server-rendered form fields of the commerce screens (WEB-002): native, labelled inputs with hints tied by
 * `aria-describedby`, read by the client `CommandForm`. Rendering them on the server keeps their markup out of the
 * browser bundle (CI-001 budgets). Names follow `shapes.ts`.
 */
let counter = 0;
const idFor = (name: string) => `f-${name.replace(/[^a-zA-Z0-9]/g, '-')}-${(counter = (counter + 1) % 1_000_000)}`;

export function Field({ label, name, defaultValue, type = 'text', required, hint, inputMode, autoComplete }: { label: string; name: string; defaultValue?: string | null | undefined; type?: 'text' | 'date' | 'datetime-local' | 'number'; required?: boolean; hint?: string; inputMode?: 'decimal' | 'text'; autoComplete?: string }) {
  const id = idFor(name);
  return (
    <div className="cm-native">
      <label htmlFor={id}>{label}</label>
      <input id={id} name={name} type={type} defaultValue={defaultValue ?? ''} required={required} inputMode={inputMode} autoComplete={autoComplete ?? 'off'} aria-describedby={hint ? `${id}-hint` : undefined} />
      {hint ? <small id={`${id}-hint`}>{hint}</small> : null}
    </div>
  );
}

export function TextAreaField({ label, name, defaultValue, required, hint, rows = 3 }: { label: string; name: string; defaultValue?: string | null | undefined; required?: boolean; hint?: string; rows?: number }) {
  const id = idFor(name);
  return (
    <div className="cm-native">
      <label htmlFor={id}>{label}</label>
      <textarea id={id} name={name} defaultValue={defaultValue ?? ''} required={required} rows={rows} aria-describedby={hint ? `${id}-hint` : undefined} />
      {hint ? <small id={`${id}-hint`}>{hint}</small> : null}
    </div>
  );
}

export type Option = { value: string; label: string; disabled?: boolean };
export function SelectField({ label, name, options, defaultValue, required, hint }: { label: string; name: string; options: Option[]; defaultValue?: string | undefined; required?: boolean; hint?: string }) {
  const id = idFor(name);
  return (
    <div className="cm-native">
      <label htmlFor={id}>{label}</label>
      <select id={id} name={name} defaultValue={defaultValue} required={required} aria-describedby={hint ? `${id}-hint` : undefined}>
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      {hint ? <small id={`${id}-hint`}>{hint}</small> : null}
    </div>
  );
}

export function CheckField({ label, name, defaultChecked, hint }: { label: string; name: string; defaultChecked?: boolean; hint?: string }) {
  const id = idFor(name);
  return (
    <span className="cm-check">
      <input id={id} name={name} type="checkbox" defaultChecked={defaultChecked} aria-describedby={hint ? `${id}-hint` : undefined} />
      <span>
        <label htmlFor={id}>{label}</label>
        {hint ? (
          <small id={`${id}-hint`} className="cm-spec">
            {hint}
          </small>
        ) : null}
      </span>
    </span>
  );
}

export function Hidden({ name, value }: { name: string; value: string }) {
  return <input type="hidden" name={name} value={value} />;
}

export function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset className="cm-group">
      <legend>{label}</legend>
      {children}
    </fieldset>
  );
}

type LineValue = { lineId: string; kind: 'goods' | 'works' | 'services' | null; description: string; quantity: { value: string; unit: string } | null; alternativesAllowed: boolean; specification: Record<string, string> };

/**
 * Lines of a need or an RFQ draft: existing lines (each can be removed) and blank rows for new ones (blank rows are
 * ignored on save; more rows appear after saving). Goods, works and services may be mixed; units come from the
 * measurement-unit catalogue. Every control names its line number for screen readers.
 */
export function LinesFields({ lines, strict, blank = 2 }: { lines: readonly LineValue[]; strict: boolean; blank?: number }) {
  const rows: Array<LineValue | null> = [...lines, ...Array.from({ length: lines.length === 0 ? Math.max(blank, 1) : blank }, () => null)];
  const kinds: Option[] = [
    { value: '', label: t('commerce.lines.kindUnset') },
    { value: 'goods', label: t('kind.goods') },
    { value: 'works', label: t('kind.works') },
    { value: 'services', label: t('kind.services') },
  ];
  const units: Option[] = UNIT_OPTIONS.map((u) => ({ value: u.id, label: u.label }));
  return (
    <fieldset className="cm-group">
      <legend>{t('commerce.lines.title')}</legend>
      <p className="ws-muted">{t('commerce.lines.hint')}</p>
      <Hidden name="lines" value={String(rows.length)} />
      {rows.map((line, i) => {
        const n = i + 1;
        const p = `line.${i}.`;
        return (
          <fieldset key={line?.lineId ?? `new-${i}`} className="cm-line">
            <legend>{line ? t('commerce.lines.line', { n }) : t('commerce.lines.newLine', { n })}</legend>
            {line ? <Hidden name={`${p}lineId`} value={line.lineId} /> : null}
            {line && Object.keys(line.specification).length ? <Hidden name={`${p}spec`} value={JSON.stringify(line.specification)} /> : null}
            <Field label={t('commerce.lines.description', { n })} name={`${p}description`} defaultValue={line?.description} required={line !== null} />
            <div className="cm-line__grid">
              <SelectField label={t('commerce.lines.kind', { n })} name={`${p}kind`} options={kinds} defaultValue={line?.kind ?? ''} required={strict && line !== null} />
              <Field label={t('commerce.lines.quantity', { n })} name={`${p}quantity`} defaultValue={line?.quantity?.value} inputMode="decimal" required={strict && line !== null} />
              <SelectField label={t('commerce.lines.unit', { n })} name={`${p}unit`} options={units} defaultValue={line?.quantity?.unit ?? 'pc'} />
            </div>
            <CheckField label={t('commerce.lines.alternatives', { n })} name={`${p}alternatives`} defaultChecked={line?.alternativesAllowed ?? false} />
            {line ? <CheckField label={t('commerce.lines.remove', { n })} name={`${p}remove`} /> : null}
          </fieldset>
        );
      })}
    </fieldset>
  );
}
