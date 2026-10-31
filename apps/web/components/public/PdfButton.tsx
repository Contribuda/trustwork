'use client';

import { Button, TooltipTrigger, Tooltip } from '@trustwork/ui';
import type { IssueView } from '@/app/_lib/data';
import { t } from '@/app/_lib/i18n';

/**
 * PDF action for an issue. The download endpoint (`/magazine/[issue]/pdf`) is CNT-001's: until it exists
 * both states render a disabled button (`aria-disabled`, reason in a tooltip and in visually hidden text):
 * «PDF готовится» when no artifact exists for the edition, «PDF будет доступен после запуска» (with size) when it does.
 */
export function PdfButton({ pdf, size = 'md' }: { pdf: IssueView['pdf']; size?: 'sm' | 'md' }) {
  const ready = pdf.state === 'ready';
  const label = ready ? `${t('magazine.pdfAfterLaunch')} · ${t('magazine.downloadPdfMeta', { size: pdf.size })}` : t('magazine.pdfPending');
  const reason = ready ? t('magazine.pdfAfterLaunchReason') : t('magazine.pdfPendingReason');
  const id = `pdf-reason-${ready ? 'ready' : 'pending'}`;
  return (
    <TooltipTrigger delay={200}>
      <Button variant="secondary" size={size} isDisabled aria-describedby={id}>
        {label}
      </Button>
      <Tooltip>{reason}</Tooltip>
      <span id={id} style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
        {reason}
      </span>
    </TooltipTrigger>
  );
}
