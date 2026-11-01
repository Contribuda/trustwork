import { useId, useState, type ReactNode } from "react";
import { Button } from "../Button/Button";
export function InlineHelp({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div>
      <Button
        variant="ghost"
        aria-expanded={open}
        aria-controls={id}
        onPress={() => setOpen(!open)}
      >
        {label}
      </Button>
      <div id={id} hidden={!open}>
        {children}
      </div>
    </div>
  );
}
