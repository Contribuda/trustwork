'use client';

import { useState, type ReactNode } from 'react';
import { Menu } from 'lucide-react';
import { Button, Dialog } from '@trustwork/ui';

/**
 * Below 768 px the console navigation becomes a full-height sheet with the same groups (screens.md, "Mobile"). The
 * navigation itself is rendered on the server and handed in; labels arrive as props.
 */
export function NavSheet({ label, title, children }: { label: string; title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="admin-band__menu">
      <Button variant="secondary" size="sm" icon={Menu} onPress={() => setOpen(true)} aria-haspopup="dialog">
        {label}
      </Button>
      <Dialog title={title} isOpen={open} onOpenChange={setOpen} size="sheet">
        <div onClickCapture={(event) => (event.target as HTMLElement).closest('a') && setOpen(false)}>{children}</div>
      </Dialog>
    </div>
  );
}
