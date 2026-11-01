'use client';

import { Button, ButtonLink, TooltipTrigger, Tooltip } from '@trustwork/ui';
import type { IssueView } from '@/app/_lib/data';
import { t } from '@/app/_lib/i18n';

/** Downloads a guarded live artifact; demo previews and pending editions remain unavailable. */
export function PdfButton({ pdf, size = 'md' }: { pdf: IssueView['pdf']; size?: 'sm' | 'md' }) {
  if (pdf.state === 'available') return <ButtonLink href={pdf.href} download variant="secondary" size={size}>{t('magazine.downloadPdf')}</ButtonLink>;
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
