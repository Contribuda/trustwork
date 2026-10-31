import type { ReactNode } from 'react';
import { TextField } from '@/components/ui';
import { t } from '@/app/_lib/i18n';
import type { ConsoleFormLabels } from './ConsoleForm';

/** Labels of a staff mutation form: the submit text, the required reason, the audit note and, when relevant, the second-person note. */
export function formLabels({ submit, secondPerson = false }: { submit: string; secondPerson?: boolean }): ConsoleFormLabels {
  return {
    submit,
    reason: t('admin.common.reason'),
    reasonHelp: t('admin.common.reasonHelp'),
    auditNote: t('admin.common.auditNote'),
    ...(secondPerson ? { secondPersonNote: t('admin.common.secondPersonNote') } : {}),
  };
}

/** A native select with a visible label; the name starts with `f.` so the value reaches the command. */
export function SelectField({ name, label, options, defaultValue, description }: { name: string; label: string; options: ReadonlyArray<{ value: string; label: string }>; defaultValue?: string | undefined; description?: string | undefined }) {
  const id = `field-${name.replace(/[^a-zA-Z0-9]/g, '-')}`;
  return (
    <div className="admin-field">
      <label htmlFor={id} className="admin-field__label">
        {label}
      </label>
      <select id={id} name={`f.${name}`} className="admin-select" defaultValue={defaultValue} {...(description ? { 'aria-describedby': `${id}-help` } : {})}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {description ? (
        <p id={`${id}-help`} className="admin-field__help">
          {description}
        </p>
      ) : null}
    </div>
  );
}

export function TextInput({ name, label, description, isRequired = false, defaultValue }: { name: string; label: string; description?: string | undefined; isRequired?: boolean; defaultValue?: string | undefined }) {
  return <TextField name={`f.${name}`} label={label} description={description} isRequired={isRequired} {...(defaultValue !== undefined ? { defaultValue } : {})} />;
}

/** The read-only explanation for a viewer who may read a section but not change it. */
export function readOnlyReason(canEdit: boolean, offline: boolean): string | null {
  if (offline) return t('admin.common.offlineDisabled');
  return canEdit ? null : t('admin.common.readOnly');
}

export function FieldGroup({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="admin-fieldset">
      <legend>{legend}</legend>
      {children}
    </fieldset>
  );
}
