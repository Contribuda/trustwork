import { t, tDynamic } from '@/app/_lib/i18n';
import { submitConsoleCommand } from '../../../../_data/actions';
import { ConsoleForm } from '../../../../_components/ConsoleForm';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { formLabels, readOnlyReason, SelectField, TextInput } from '../../../../_components/forms';
import { longDate } from '../../../../_components/format';
import { ConsoleHeader, KeyValues, Panel } from '../../../../_components/shell';
import { Cohort, Empty, loadProduct, onOff } from '../_kit/parts';

const REASONS = ['issued_in_error', 'fraud', 'course_withdrawn'] as const;

async function Learning(ctx: HubContext) {
  const { learning } = (await loadProduct(ctx)).modules;
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('admin.modules.learning.title')} lede={t('admin.modules.learning.lede')} />
      <div className="admin-grid">
        <Panel id="certificates" title={t('admin.modules.learning.certificates')}>
          <KeyValues
            rows={[
              { label: t('admin.modules.learning.issued'), value: <Cohort value={learning.certificates.issued} /> },
              { label: t('admin.modules.learning.revoked'), value: <Cohort value={learning.certificates.revoked} /> },
              { label: t('admin.modules.learning.expired'), value: <Cohort value={learning.certificates.expired} /> },
              { label: t('admin.modules.learning.revocationRequests'), value: learning.revocationRequests },
              { label: t('admin.modules.learning.paidCourses'), value: onOff(learning.paidCourses) },
            ]}
          />
          <p className="admin-note">{t('admin.modules.learning.private')}</p>
        </Panel>
        <Panel id="accreditations" title={t('admin.modules.learning.accreditations')}>
          {learning.accreditations.length ? (
            <ul className="admin-list">
              {learning.accreditations.map((a) => (
                <li key={a.id} className="admin-list__row">
                  <span lang={a.body.lang}>{a.body.text}</span>
                  <span className="admin-meta">
                    <a href={a.source} rel="noopener noreferrer" target="_blank">
                      {t('admin.modules.learning.source')}
                      <span className="admin-visually-hidden"> {t('admin.common.opensNewTab')}</span>
                    </a>
                    {a.validUntil ? ` · ${t('admin.modules.learning.validUntil', { date: longDate(a.validUntil) })}` : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>{t('admin.modules.learning.noAccreditations')}</Empty>
          )}
        </Panel>
      </div>
      <Panel id="courses-review" title={t('admin.modules.learning.review')}>
        {learning.inReview.length ? (
          <>
            <ul className="admin-list">
              {learning.inReview.map((c) => (
                <li key={c.id} className="admin-list__row">
                  <span lang={c.title.lang}>{c.title.text}</span>
                  <span className="admin-meta">
                    {longDate(c.submittedAt)} · <code className="admin-code">{c.id}</code>
                  </span>
                </li>
              ))}
            </ul>
            <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('learning.review')} labels={formLabels({ submit: t('admin.modules.learning.decide') })} disabledReason={readOnlyReason(ctx.can('admin.learning.review'), ctx.offline)}>
              <div className="admin-form__grid">
                <SelectField name="courseId" label={t('admin.modules.learning.course')} options={learning.inReview.map((c) => ({ value: c.id, label: c.id }))} />
                <SelectField
                  name="decision"
                  label={t('admin.modules.learning.decision')}
                  options={[
                    { value: 'approve', label: t('admin.modules.learning.approve') },
                    { value: 'return', label: t('admin.modules.learning.return') },
                  ]}
                />
              </div>
            </ConsoleForm>
          </>
        ) : (
          <Empty>{t('admin.modules.learning.noReview')}</Empty>
        )}
      </Panel>
      <div className="admin-grid">
        <Panel id="revoke-certificate" title={t('admin.modules.learning.revoke')}>
          <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('learning.revoke_certificate')} labels={formLabels({ submit: t('admin.modules.learning.revoke') })} submitVariant="danger" disabledReason={readOnlyReason(ctx.can('admin.learning.certificate.revoke'), ctx.offline)}>
            <TextInput name="certificateRef" label={t('admin.modules.learning.certificateRef')} description={t('admin.modules.learning.certificateRefHelp')} isRequired />
            <SelectField name="reasonCategory" label={t('admin.modules.learning.reasonCategory')} options={REASONS.map((r) => ({ value: r, label: tDynamic(`admin.modules.learning.reasons.${r}`, r) }))} />
          </ConsoleForm>
        </Panel>
        <Panel id="record-accreditation" title={t('admin.modules.learning.record')}>
          <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('learning.record_accreditation')} labels={formLabels({ submit: t('admin.modules.learning.record') })} disabledReason={readOnlyReason(ctx.can('admin.learning.accreditation.record'), ctx.offline)}>
            <TextInput name="body" label={t('admin.modules.learning.body')} isRequired />
            <TextInput name="source" label={t('admin.modules.learning.sourceUrl')} description={t('admin.modules.learning.sourceHelp')} isRequired />
          </ConsoleForm>
        </Panel>
      </div>
    </>
  );
}

/** HC-65 Learning: course review, certificate counts and revocation by reason category, accreditations only with a source. */
export const screen: Screen = { group: 'modules', id: 'learning', title: () => t('admin.modules.learning.title'), render: Learning };
