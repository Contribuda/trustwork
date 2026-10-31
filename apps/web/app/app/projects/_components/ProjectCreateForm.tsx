'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CreateProjectCommandSchema } from '@trustwork/contracts/client';
import { Button, Dialog, Form, FormAlert, Radio, RadioGroup, TextArea, TextField } from '@trustwork/ui';
import { mapFieldErrors, useAuthForm } from '@/components/auth/useAuthForm';
import { t } from '@/app/_lib/i18n';

const FIELD_MAP = {
  name: { required: 'projectsWs.createForm.error.nameRequired', too_long: 'projectsWs.createForm.error.nameTooLong', invalid: 'projectsWs.createForm.error.nameRequired' },
  summary: { too_long: 'projectsWs.createForm.error.summaryTooLong', invalid: 'projectsWs.createForm.error.summaryTooLong' },
} as const;

export type ProjectOwnerOption = { kind: 'person' | 'company'; id: string; label: string };

/**
 * Creates a project (`POST /v1/projects`, WEB-004). A personal project is owned by its creator and needs no company;
 * a company project is offered only to a member holding `company.deals.manage` (the API checks it again). Projects
 * start private; publishing is a separate, explicit step on the project page.
 */
export function ProjectCreateForm({ owners }: { owners: ProjectOwnerOption[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [summary, setSummary] = useState('');
  const [owner, setOwner] = useState(0);
  const form = useAuthForm();

  return (
    <>
      <Button variant="accent" onPress={() => setOpen(true)}>
        {t('projectsWs.create')}
      </Button>
      <Dialog
        title={t('projectsWs.createForm.title')}
        description={t('projectsWs.createForm.body')}
        isOpen={open}
        onOpenChange={setOpen}
        isLoading={form.busy}
        actions={
          <>
            <Button variant="ghost" onPress={() => setOpen(false)}>
              {t('projectsWs.createForm.cancel')}
            </Button>
            <Button type="submit" form="project-create-form" variant="accent" isLoading={form.busy} pendingLabel={t('projectsWs.createForm.pending')}>
              {t('projectsWs.createForm.submit')}
            </Button>
          </>
        }
      >
        {form.alert ? <FormAlert tone={form.alert.tone}>{form.alert.text}</FormAlert> : null}
        <Form
          id="project-create-form"
          validationBehavior="aria"
          {...(form.hydrated ? { 'data-hydrated': '' } : {})}
          isBusy={form.busy}
          onSubmit={async (event) => {
            event.preventDefault();
            const chosen = owners[owner] ?? owners[0]!;
            const payload = { owner: { kind: chosen.kind, id: chosen.id }, name, summary: summary.trim() ? summary.trim() : null, leaderPersonId: null };
            const response = await form.submit({ path: '/v1/projects', payload, schema: CreateProjectCommandSchema, idempotent: true, onError: (error) => mapFieldErrors(form.fieldIssues(error), FIELD_MAP) });
            if (response.kind === 'ok' && typeof response.body.id === 'string') router.push(`/app/projects/${response.body.id}`);
          }}
        >
          <div className="au-form__fields">
            <TextField id="project-name" label={t('projectsWs.createForm.name')} value={name} onChange={setName} isRequired errorMessage={form.fields.name} isDisabled={form.busy} />
            <TextArea id="project-summary" label={t('projectsWs.createForm.summary')} value={summary} onChange={setSummary} rows={3} maxLength={4000} errorMessage={form.fields.summary} isDisabled={form.busy} />
            {owners.length > 1 ? (
              <RadioGroup label={t('projectsWs.createForm.owner')} value={String(owner)} onChange={(value) => setOwner(Number(value))} isDisabled={form.busy}>
                {owners.map((o, i) => (
                  <Radio key={`${o.kind}-${o.id}`} value={String(i)}>
                    {o.kind === 'person' ? t('projectsWs.createForm.ownerMe') : t('projectsWs.createForm.ownerCompany', { name: o.label })}
                  </Radio>
                ))}
              </RadioGroup>
            ) : null}
          </div>
        </Form>
      </Dialog>
    </>
  );
}
