import type { ReactNode } from "react";
import { t } from "../../i18n";
import { Dialog } from "../Dialog/Dialog";
import { TextField } from "../TextField/TextField";
import { Button } from "../Button/Button";
export type TypedConfirmationProps = {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  expected: string;
  value: string;
  onChange: (value: string) => void;
  confirmLabel: string;
  onConfirm: () => void;
  pending?: boolean | undefined;
  error?: string | undefined;
};
export function TypedConfirmation({
  isOpen,
  onOpenChange,
  title,
  children,
  expected,
  value,
  onChange,
  confirmLabel,
  onConfirm,
  pending,
  error,
}: TypedConfirmationProps) {
  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={title}
      actions={
        <>
          <Button
            autoFocus
            variant="secondary"
            onPress={() => onOpenChange(false)}
          >
            {t("common.cancel")}
          </Button>
          <Button
            variant="danger"
            isDisabled={value !== expected || !expected}
            isLoading={pending}
            onPress={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      <TextField
        label={t("consoleKit.typeToConfirm", { value: expected })}
        name="confirmation"
        autoComplete="on"
        value={value}
        onChange={onChange}
        errorMessage={error}
      />
    </Dialog>
  );
}
