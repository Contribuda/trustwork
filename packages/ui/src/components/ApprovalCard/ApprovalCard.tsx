import type { ReactNode } from "react";
import { useId } from "react";
import { t } from "../../i18n";
import { Button } from "../Button/Button";
import { ReasonField, AuditNote } from "../StepUpPrompt/ReasonField";
import { ConsoleTime } from "../AuditTrail/AuditTrail";
import s from "../DataTable/console.module.css";
export type ApprovalCardProps = {
  title: string;
  scope: string;
  requester: string;
  reason: string;
  digest: string;
  expiresAt: string;
  timeZone: string;
  children?: ReactNode;
  declineReason: string;
  onDeclineReasonChange: (reason: string) => void;
  approve: { onPress: () => void; disabledReason?: string | undefined };
  decline: { onPress: () => void; disabledReason?: string | undefined };
  pending?: boolean | undefined;
  error?: string | undefined;
  /** Override when the caller has different persistence semantics, such as a fixture-only simulation. */
  auditNote?: ReactNode;
};
/** Shows the caller's decision availability; never derives permission from identity, digest or time. */
export function ApprovalCard(p: ApprovalCardProps) {
  const id = useId();
  return (
    <article className={s.panel} aria-labelledby={id}>
      <h2 id={id}>{p.title}</h2>
      <p>
        {p.scope} · {p.requester}
      </p>
      <p>{p.reason}</p>
      <code>{p.digest}</code>
      <p>
        <ConsoleTime value={p.expiresAt} timeZone={p.timeZone} />
      </p>
      {p.children}
      <ReasonField
        value={p.declineReason}
        onChange={p.onDeclineReasonChange}
        errorMessage={p.error}
      />
      <div className={s.row}>
        <Button
          variant="secondary"
          isDisabled={!p.declineReason.trim() || !!p.decline.disabledReason}
          isLoading={p.pending}
          onPress={p.decline.onPress}
        >
          {t("consoleKit.decline")}
        </Button>
        <Button
          isDisabled={!!p.approve.disabledReason}
          isLoading={p.pending}
          onPress={p.approve.onPress}
        >
          {t("consoleKit.approve")}
        </Button>
      </div>
      {p.approve.disabledReason && <p>{p.approve.disabledReason}</p>}
      {p.decline.disabledReason && <p>{p.decline.disabledReason}</p>}
      {p.auditNote === undefined ? <AuditNote /> : <AuditNote>{p.auditNote}</AuditNote>}
    </article>
  );
}
