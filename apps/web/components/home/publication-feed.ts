/** Independent home sections stay available when a content service is unavailable. No fixture fallback. */
export async function homePublications<T>(source: { listArticles(): Promise<T[]>; listNews(): Promise<T[]> }) {
  const [articles, news] = await Promise.allSettled([source.listArticles(), source.listNews()]);
  return {
    articles: articles.status === 'fulfilled' ? articles.value : [],
    news: news.status === 'fulfilled' ? news.value : [],
    unavailable: articles.status === 'rejected' || news.status === 'rejected',
  };
}
