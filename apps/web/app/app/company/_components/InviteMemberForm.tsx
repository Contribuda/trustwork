'use client';

import { useState } from 'react';
import { COMPANY_PERMISSIONS, InviteMemberCommandSchema, type CompanyPermission } from '@trustwork/contracts/client';
import { Button, Checkbox, Form, FormActions, FormAlert, Radio, RadioGroup, TextField } from '@trustwork/ui';
import { mapFieldErrors, useAuthForm } from '@/components/auth/useAuthForm';
import { useStepUp } from '@/components/auth/StepUp';
import { t } from '@/app/_lib/i18n';

const FIELD_MAP = { inviteeEmail: { required: 'auth.error.emailRequired', format: 'auth.error.emailFormat', invalid: 'auth.error.emailFormat' } } as const;

/** Locale key of each company permission label (`company.permissionLabel.*`). */
const PERMISSION_LABEL: Record<CompanyPermission, `company.permissionLabel.${string}`> = {
  'company.page.edit': 'company.permissionLabel.pageEdit',
  'company.publish': 'company.permissionLabel.publish',
  'company.members.manage': 'company.permissionLabel.membersManage',
  'company.deals.manage': 'company.permissionLabel.dealsManage',
  'company.catalogue.edit': 'company.permissionLabel.catalogueEdit',
  'company.billing.view': 'company.permissionLabel.billingView',
  'company.billing.manage': 'company.permissionLabel.billingManage',
};

/**
 * Invites a colleague by e-mail (`POST /v1/companies/:id/memberships`, step-up). The answer is the same whether or
 * not the address belongs to an account, so the form never reveals who is registered. Permissions are chosen
 * explicitly; nothing is granted by default.
 */
export function InviteMemberForm({ companyId }: { companyId: string }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'administrator'>('member');
  const [permissions, setPermissions] = useState<CompanyPermission[]>([]);
  const form = useAuthForm();
  const stepUp = useStepUp();

  return (
    <section aria-labelledby="invite-title" className="ws-card" style={{ maxWidth: '40rem' }}>
      <h3 id="invite-title" className="ws-h2">
        {t('company.inviteForm.title')}
      </h3>
      <p className="ws-muted">{t('company.inviteForm.body')}</p>
      {form.alert ? (
        <FormAlert tone={form.alert.tone} autoFocus>
          {form.alert.text}
        </FormAlert>
      ) : null}
      <Form
        validationBehavior="aria"
        {...(form.hydrated ? { 'data-hydrated': '' } : {})}
        aria-labelledby="invite-title"
        isBusy={form.busy}
        onSubmit={async (event) => {
          event.preventDefault();
          const payload = { companyId, inviteeEmail: email, role, permissions };
          const response = await stepUp.guard(
            () => form.submit({ path: `/v1/companies/${encodeURIComponent(companyId)}/memberships`, payload, schema: InviteMemberCommandSchema, idempotent: true, onError: (error) => mapFieldErrors(form.fieldIssues(error), FIELD_MAP) }),
            () => form.setAlert(null),
          );
          if (response.kind === 'ok') {
            form.setAlert({ tone: 'success', text: t('company.inviteForm.sent') });
            setEmail('');
            setPermissions([]);
          }
        }}
      >
        <div className="au-form__fields">
          <TextField id="invite-inviteeEmail" label={t('auth.email')} type="email" inputMode="email" autoComplete="off" value={email} onChange={setEmail} isRequired errorMessage={form.fields.inviteeEmail} isDisabled={form.busy} />
          <RadioGroup label={t('company.member.role')} value={role} onChange={(value) => setRole(value === 'administrator' ? 'administrator' : 'member')} orientation="horizontal" isDisabled={form.busy}>
            <Radio value="member">{t('role.member')}</Radio>
            <Radio value="administrator">{t('role.administrator')}</Radio>
          </RadioGroup>
          <fieldset className="ws-fieldset">
            <legend className="ws-head__kicker">{t('company.inviteForm.permissions')}</legend>
            {COMPANY_PERMISSIONS.map((permission) => (
              <Checkbox
                key={permission}
                isSelected={permissions.includes(permission)}
                isDisabled={form.busy}
                onChange={(on) => setPermissions((current) => (on ? [...current, permission] : current.filter((p) => p !== permission)))}
              >
                {t(PERMISSION_LABEL[permission] as 'company.permissionLabel.pageEdit')}
              </Checkbox>
            ))}
          </fieldset>
          <FormActions>
            <Button type="submit" isLoading={form.busy} pendingLabel={t('company.inviteForm.pending')}>
              {t('company.inviteForm.submit')}
            </Button>
          </FormActions>
        </div>
      </Form>
      {stepUp.dialog}
    </section>
  );
}
