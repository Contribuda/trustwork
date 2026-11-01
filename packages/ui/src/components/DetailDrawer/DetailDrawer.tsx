import {
  useEffect,
  useId,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { t } from "../../i18n";
import { Button } from "../Button/Button";
import { Link } from "../Link/Link";
import s from "../DataTable/console.module.css";
export type DetailDrawerProps = {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  pageHref: string;
  children: ReactNode;
  returnFocusTo?: RefObject<HTMLElement | null> | undefined;
};
export function DetailDrawer({
  isOpen,
  onClose,
  title,
  pageHref,
  children,
  returnFocusTo,
}: DetailDrawerProps) {
  const id = useId();
  const ref = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!isOpen) return;
    opener.current =
      returnFocusTo?.current ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
    ref.current?.focus();
    return () => {
      const target = returnFocusTo?.current ?? opener.current;
      if (target?.isConnected) target.focus();
    };
  }, [isOpen, returnFocusTo]);
  if (!isOpen) return null;
  return (
    <aside
      ref={ref}
      tabIndex={-1}
      aria-labelledby={id}
      className={`${s.panel} ${s.drawer}`}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className={s.row}>
        <h2 id={id}>{title}</h2>
        <Button variant="secondary" onPress={onClose}>
          {t("common.close")}
        </Button>
      </div>
      <Link href={pageHref}>{t("consoleKit.openPage")}</Link>
      {children}
    </aside>
  );
}
