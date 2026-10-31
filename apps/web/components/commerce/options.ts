import { regionCodes, regionLabel } from '@/app/_lib/country';
import type { AuthenticatedPrincipal } from '@/app/_lib/data/types';
import { t } from '@/app/_lib/i18n';
import type { Option } from './fields';

/** Who may own a need or an RFQ: the person always; the employer only with the deals grant (the API checks it again). */
export function ownerOptions(principal: AuthenticatedPrincipal): Option[] {
  return [
    { value: `person:${principal.personId}`, label: t('commerce.need.ownerMe') },
    ...(principal.company?.permissions.includes('company.deals.manage') ? [{ value: `company:${principal.company.id}`, label: t('commerce.need.ownerCompany', { name: principal.company.name }) }] : []),
  ];
}

/** Regions of the visitor's country pack (place codes), plus the stored value when it is free text; restricted places are refused again by the API. */
export function regionOptions(current: string | null | undefined): Option[] {
  const codes = [...regionCodes()];
  return [{ value: '', label: t('commerce.need.regionUnset') }, ...codes.map((code) => ({ value: code, label: regionLabel(code) })), ...(current && !codes.includes(current) ? [{ value: current, label: current }] : [])];
}
