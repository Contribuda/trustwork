'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { PublishProjectCommandSchema } from '@trustwork/contracts/client';
import { z } from 'zod';
import { Button, Form, FormActions, FormAlert, TextArea } from '@trustwork/ui';
import { mapFieldErrors, useAuthForm } from '@/components/auth/useAuthForm';
import { t } from '@/app/_lib/i18n';

/** The contract allows an empty story; the interface asks for one, since it is all the public sees. */
const PublishSchema = PublishProjectCommandSchema.extend({ publishedStory: z.string().trim().min(1).max(20_000) });

const FIELD_MAP = { publishedStory: { required: 'projectsWs.publish.error.storyRequired', too_long: 'projectsWs.publish.error.storyTooLong', invalid: 'projectsWs.publish.error.storyRequired' } } as const;

/**
 * Publishes a project (`POST /v1/projects/:id/publish`, WEB-004): only the published story and the public fields of
 * the project become visible; budgets, files, notes and participants never do. The command names the revision the
 * owner saw, so a concurrent change answers `validation.revision_conflict` instead of being overwritten.
 */
export function PublishProjectForm({ projectId, revision }: { projectId: string; revision: number }) {
  const router = useRouter();
  const [story, setStory] = useState('');
  const form = useAuthForm();
  return (
    <section aria-labelledby="publish-title" className="ws-card">
      <h3 id="publish-title" className="ws-h2">
        {t('projectsWs.publish.title')}
      </h3>
      <p className="ws-muted">{t('projectsWs.publish.body')}</p>
      {form.alert ? (
        <FormAlert tone={form.alert.tone} autoFocus>
          {form.alert.text}
        </FormAlert>
      ) : null}
      <Form
        validationBehavior="aria"
        {...(form.hydrated ? { 'data-hydrated': '' } : {})}
        aria-labelledby="publish-title"
        isBusy={form.busy}
        onSubmit={async (event) => {
          event.preventDefault();
          const payload = { projectId, publishedStory: story, openNeedIds: [], expectedRevision: revision };
          const response = await form.submit({ path: `/v1/projects/${encodeURIComponent(projectId)}/publish`, payload, schema: PublishSchema, idempotent: true, onError: (error) => mapFieldErrors(form.fieldIssues(error), FIELD_MAP) });
          if (response.kind === 'ok') router.refresh();
        }}
      >
        <div className="au-form__fields">
          <TextArea id="publish-publishedStory" label={t('projectsWs.publish.story')} description={t('projectsWs.publish.storyHint')} value={story} onChange={setStory} rows={5} maxLength={4000} isRequired errorMessage={form.fields.publishedStory} isDisabled={form.busy} />
          <FormActions>
            <Button type="submit" variant="accent" isLoading={form.busy} pendingLabel={t('projectsWs.publish.pending')}>
              {t('projectsWs.publish.submit')}
            </Button>
          </FormActions>
        </div>
      </Form>
    </section>
  );
}
