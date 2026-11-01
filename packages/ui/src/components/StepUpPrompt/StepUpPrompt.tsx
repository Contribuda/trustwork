import { t } from "../../i18n";
import { Button } from "../Button/Button";
import { PasswordField, TextField } from "../TextField/TextField";
import s from "../DataTable/console.module.css";
export type StepUpPromptProps = {
  method: "code" | "password";
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onPasskey?: (() => void) | undefined;
  onCancel: () => void;
  status: "idle" | "pending" | "confirmed" | "error";
  error?: string | undefined;
};
/** First-party authentication presentation only: success is supplied by the real caller. */
export function StepUpPrompt({
  method,
  value,
  onChange,
  onSubmit,
  onPasskey,
  onCancel,
  status,
  error,
}: StepUpPromptProps) {
  return (
    <section
      className={s.panel}
      aria-label={t("consoleKit.stepUp")}
      aria-busy={status === "pending"}
    >
      <h2>{t("consoleKit.stepUp")}</h2>
      <form
        className={s.stack}
        onSubmit={(event) => {
          event.preventDefault();
          if (value && status !== "pending" && status !== "confirmed")
            onSubmit();
        }}
      >
        {method === "password" ? (
          <PasswordField
            label={t("consoleKit.password")}
            name="password"
            autoComplete="current-password"
            value={value}
            onChange={onChange}
            errorMessage={error}
          />
        ) : (
          <TextField
            label={t("consoleKit.code")}
            name="one-time-code"
            autoComplete="one-time-code"
            inputMode="numeric"
            value={value}
            onChange={onChange}
            errorMessage={error}
          />
        )}
        <div className={s.row}>
          <Button variant="secondary" onPress={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            isDisabled={!value || status === "confirmed"}
            isLoading={status === "pending"}
          >
            {t("consoleKit.verify")}
          </Button>
          {onPasskey && (
            <Button
              variant="secondary"
              onPress={onPasskey}
              isDisabled={status === "pending"}
            >
              {t("consoleKit.passkey")}
            </Button>
          )}
        </div>
        <p role="status" aria-live="polite">
          {status === "confirmed" ? t("consoleKit.confirmed") : ""}
        </p>
      </form>
    </section>
  );
}
