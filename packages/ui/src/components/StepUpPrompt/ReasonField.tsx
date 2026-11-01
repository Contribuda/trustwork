import { t } from "../../i18n";
import { TextArea, type TextAreaProps } from "../TextField/TextField";
export type ReasonFieldProps = Omit<TextAreaProps, "label"> & {
  label?: string | undefined;
};
/** Promoted from ConsoleForm; native form submission and label overrides remain compatible. */
export function ReasonField({
  label = t("consoleKit.reason"),
  description = t("consoleKit.reasonHelp"),
  ...props
}: ReasonFieldProps) {
  return (
    <TextArea
      isRequired
      rows={2}
      maxLength={500}
      showCounter
      label={label}
      description={description}
      {...props}
    />
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
