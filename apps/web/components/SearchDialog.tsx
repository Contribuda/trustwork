'use client';

import { useState } from 'react';
import { Button, Dialog, Form, RetrievalStatusBanner, TextField } from '@trustwork/ui';
import { t } from '@/app/_lib/i18n';

/**
 * Global search entry (public header and workspace header). Search results and cited answers are
 * delivered by WEB-003; until then a submitted query renders the contract «unavailable» state
 * instead of pretending to search.
 */
export function SearchDialog({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState(false);
  return (
    <Dialog
      title={t('shell2.searchTitle')}
      isOpen={isOpen}
      onOpenChange={(open) => {
        onOpenChange(open);
        if (!open) setSubmitted(false);
      }}
      size="sm"
      description={t('shell2.searchHint')}
    >
      <Form
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(true);
        }}
      >
        <TextField label={t('shell2.searchLabel')} value={query} onChange={setQuery} placeholder={t('search.placeholder')} inputMode="search" autoComplete="off" />
        <div style={{ marginTop: 'var(--space-3)' }}>
          <Button type="submit" variant="secondary">
            {t('publicPages.find')}
          </Button>
        </div>
      </Form>
      {submitted ? (
        <div style={{ marginTop: 'var(--space-4)' }}>
          <RetrievalStatusBanner status="unavailable" />
        </div>
      ) : null}
    </Dialog>
  );
}
