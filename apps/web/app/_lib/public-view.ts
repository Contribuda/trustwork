/** The query of a public list view: the request's search params (filters, search, pagination). */
export type ViewQuery = Record<string, string | string[] | undefined>;

/** Props of a public list view (WEB-005): the language from the URL and the query. */
export type ViewProps = { lang: string; query: ViewQuery };
