import { t } from "../../i18n";
import { Link } from "../Link/Link";
import s from "../DataTable/console.module.css";
export function LockedRule({
  title,
  explanation,
  sourceHref,
}: {
  title: string;
  explanation: string;
  sourceHref: string;
}) {
  return (
    <div className={s.panel}>
      <strong>{title}</strong>
      <p>{t("consoleKit.locked")}</p>
      <p>{explanation}</p>
      <Link href={sourceHref}>{t("consoleKit.rule")}</Link>
    </div>
  );
}
