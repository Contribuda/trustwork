import { withPublicLocale } from '@/app/_lib/locale';
import { contentFeedResponse } from '@/components/public/magazine/feed-response';

export const GET = withPublicLocale(() => contentFeedResponse('news', 'rss'));
