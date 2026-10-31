import { t } from '@/app/_lib/i18n';
import type { AuthenticatedPrincipal } from '@/app/_lib/data/types';
import { CommandForm } from './CommandForm';
import { Field, Group, LinesFields, SelectField, TextAreaField } from './fields';
import { ownerOptions, regionOptions } from './options';

type NeedValue = {
  id: string;
  revision: number;
  title: string;
  description: string | null;
  region: string | null;
  window: { from: { date: string; timeZone: string }; to: { date: string; timeZone: string } } | null;
  acceptanceCriteria: string | null;
  lines: Array<{ lineId: string; kind: 'goods' | 'works' | 'services' | null; description: string; quantity: { value: string; unit: string } | null; alternativesAllowed: boolean; specification: Record<string, string> }>;
};

/**
 * Intake (`POST /v1/needs`) and clarification (`POST /v1/needs/:id`) of a need. Nothing typed here reaches anyone: a need
 * is owner-private. The API recomputes what is still missing and the page shows it as a checklist after each save.
 */
export function NeedForm({ principal, need, demo }: { principal: AuthenticatedPrincipal; need: NeedValue | null; demo: boolean }) {
  const owners = ownerOptions(principal);
  return (
    <CommandForm
      path={need ? `/v1/needs/${encodeURIComponent(need.id)}` : '/v1/needs'}
      base={need ? { expectedRevision: need.revision } : {}}
      shape={{ kind: 'need', mode: need ? 'save' : 'create' }}
      demo={demo}
      label={need ? t('commerce.need.save') : t('commerce.need.newTitle')}
      buttons={[{ label: need ? t('commerce.need.save') : t('commerce.need.create') }]}
      {...(need ? { success: t('commerce.need.saved') } : { redirect: { base: '/app/procurement/needs', key: 'id' } })}
    >
      <p className="ws-note">{t('commerce.need.untrustedNote')}</p>
      {!need && owners.length > 1 ? <SelectField label={t('commerce.need.owner')} name="owner" options={owners} /> : <input type="hidden" name="owner" value={owners[0]!.value} />}
      <Field label={t('commerce.need.title')} name="title" defaultValue={need?.title} required />
      <TextAreaField label={t('commerce.need.description')} name="description" defaultValue={need?.description} />
      <LinesFields lines={need?.lines ?? []} strict={false} />
      <SelectField label={t('commerce.need.region')} name="region" options={regionOptions(need?.region)} defaultValue={need?.region ?? ''} />
      <Group label={t('commerce.need.window')}>
        <div className="cm-line__grid">
          <Field label={t('commerce.need.windowFrom')} name="from" type="date" defaultValue={need?.window?.from.date} />
          <Field label={t('commerce.need.windowTo')} name="to" type="date" defaultValue={need?.window?.to.date} />
        </div>
        {need?.window ? <input type="hidden" name="timeZone" value={need.window.from.timeZone} /> : null}
      </Group>
      <TextAreaField label={t('commerce.need.acceptance')} name="acceptance" defaultValue={need?.acceptanceCriteria} />
    </CommandForm>
  );
}

/** Converts a ready need into the first RFQ draft; the budget ceiling and notes go to the buyer-private record. */
export function ConvertNeedForm({ needId, revision, currency, demo }: { needId: string; revision: number; currency: string; demo: boolean }) {
  return (
    <CommandForm
      path={`/v1/needs/${encodeURIComponent(needId)}/convert`}
      base={{ expectedRevision: revision }}
      shape={{ kind: 'convert' }}
      demo={demo}
      label={t('commerce.convert.title')}
      buttons={[{ label: t('commerce.convert.submit') }]}
      redirect={{ base: '/app/procurement/rfq', key: 'rfq.id' }}
    >
      <Field label={t('commerce.rfq.currency')} name="currency" defaultValue={currency} required hint={t('commerce.convert.currencyHint')} />
      <Field label={t('commerce.rfq.deadline')} name="deadline" type="datetime-local" required />
      <TextAreaField label={t('commerce.rfq.paymentTerms')} name="payment" rows={2} />
      <Group label={t('commerce.privateLabel')}>
        <Field label={t('commerce.rfq.budgetCeiling')} name="ceiling" inputMode="decimal" />
        <TextAreaField label={t('commerce.rfq.internalNotes')} name="notes" rows={2} />
      </Group>
    </CommandForm>
  );
}
