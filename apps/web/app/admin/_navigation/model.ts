/** Pure routing data; the React boundary checks compatibility with DS005's AdminDestination. */
export type NavigationDestination = { id: string; label: string; href: string; kind: 'section' | 'command' | 'help' };
export type NavigationCopy = typeof import('../../../locales/en/console-navigation.json').consoleNav;

/** No participant index, query transport, recent-query history or inference from arbitrary text. */
export function paletteResults(query: string, destinations: readonly NavigationDestination[], support: NavigationDestination | null): NavigationDestination[] {
  const text = query.trim().toLocaleLowerCase();
  if (!text) return [...destinations];
  if (text.includes('@')) return support ? [support] : [];
  // Object lookup belongs to ADM-005. Unknown and unauthorized identifiers have the same result.
  if (text.startsWith('#')) return [];
  const commandOnly = text.startsWith('>');
  const needle = commandOnly ? text.slice(1).trim() : text;
  const matches = destinations.filter((destination) => (!commandOnly || destination.kind === 'command') && destination.label.toLocaleLowerCase().includes(needle));
  return matches.length || commandOnly ? matches : support ? [support] : [];
}

export function textEntryTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="combobox"], [role="textbox"], [role="searchbox"]');
}

export const INBOX_VIEWS = ['waiting', 'mine', 'assigned', 'done'] as const;
export const USER_VIEWS = ['people', 'companies', 'staff', 'clients'] as const;
export type InboxView = (typeof INBOX_VIEWS)[number];
export type UserView = (typeof USER_VIEWS)[number];
export const VIEW_IDS = [...INBOX_VIEWS.map((view) => `inbox:${view}` as const), ...USER_VIEWS.map((view) => `users:${view}` as const)];
export type ViewId = (typeof VIEW_IDS)[number];
export function inboxView(value: unknown): InboxView { return INBOX_VIEWS.find((view) => view === value) ?? 'waiting'; }
export function userView(value: unknown): UserView { return USER_VIEWS.find((view) => view === value) ?? 'people'; }
