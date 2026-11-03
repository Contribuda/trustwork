import { localeReviewStatement } from '@/components/locale/review';
import { withPublicLocale } from '@/app/_lib/locale';
import { offeredLanguages } from '@/app/_lib/locale-negotiation';

/**
 * Review status of the languages this deployment offers, machine readable (INTL-007): the `hubs[].languages` review
 * status of a capability statement (ADR 016). Public by nature: it names only reviewers who consented.
 */
export const GET = withPublicLocale(() => Response.json(localeReviewStatement(offeredLanguages()), { headers: { 'Cache-Control': 'public, max-age=300' } }));
