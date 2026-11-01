import { t } from "../../i18n";
import { TextArea, type TextAreaProps } from "../TextField/TextField";
import s from "../DataTable/console.module.css";
export type ReasonFieldProps = Omit<TextAreaProps, "label"> & {
  label?: string | undefined;
};
/** Promoted from ConsoleForm; native form submission and label overrides remain compatible. */
export function ReasonField({
  label = t("consoleKit.reason"),
  description = t("consoleKit.reasonHelp"),
  value,
  maxLength = 500,
  showCounter = true,
  ...props
}: ReasonFieldProps) {
  return (
    <>
      <TextArea
        isRequired
        rows={2}
        maxLength={maxLength}
        {...(value !== undefined ? { value } : {})}
        showCounter={showCounter && value === undefined}
        label={label}
        description={description}
        {...props}
      />
      {showCounter && value !== undefined && maxLength !== undefined && (
        <p className={s.muted} aria-live="polite">
          {t("common.charactersLeft", {
            count: Math.max(0, maxLength - value.length),
          })}
        </p>
      )}
    </>
  );
}
export function AuditNote({
  children = t("consoleKit.auditNote"),
  className,
}: {
  children?: React.ReactNode;
  className?: string | undefined;
}) {
  return <p className={className}>{children}</p>;
}
