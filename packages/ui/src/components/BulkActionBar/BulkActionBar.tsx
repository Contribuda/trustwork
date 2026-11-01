import { useEffect, useRef, type ReactNode } from "react";
import { formatNumber, t } from "../../i18n";
import { Button } from "../Button/Button";
import s from "../DataTable/console.module.css";
export function BulkActionBar({
  count,
  total,
  onCancel,
  children,
}: {
  count: number;
  total: number;
  onCancel: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const active = count > 0;
  useEffect(() => {
    if (!active) return;
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, [active]);
  if (!active) return null;
  return (
    <div
      ref={ref}
      className={s.panel}
      tabIndex={-1}
      role="region"
      aria-label={t("table.rowActions")}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <p role="status" aria-live="polite">
        {t("consoleKit.selected", {
          count: formatNumber(count),
          total: formatNumber(total),
        })}
      </p>
      <div className={s.row}>
        <Button variant="secondary" onPress={onCancel}>
          {t("common.cancel")}
        </Button>
        {children}
      </div>
    </div>
  );
}
