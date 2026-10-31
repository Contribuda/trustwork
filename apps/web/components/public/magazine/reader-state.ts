/**
 * Reader engagement state kept only in the browser (no server, no account): items read, bookmarks, quiz scores
 * and the poll answer per issue, plus the list of issues read to the end. Every read is wrapped so private
 * windows and blocked storage degrade to an empty state.
 */
export type IssueState = { read: number[]; bookmarks: number[]; quiz: Record<string, { score: number; total: number }>; poll: number | null };

const EMPTY: IssueState = { read: [], bookmarks: [], quiz: {}, poll: null };
const DONE_KEY = 'trustwork.magazine.done';

function key(issue: number): string {
  return `trustwork.magazine.${issue}`;
}

export function loadIssueState(issue: number): IssueState {
  try {
    const raw = window.localStorage.getItem(key(issue));
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as Partial<IssueState>;
    return {
      read: Array.isArray(parsed.read) ? parsed.read.filter((n) => typeof n === 'number') : [],
      bookmarks: Array.isArray(parsed.bookmarks) ? parsed.bookmarks.filter((n) => typeof n === 'number') : [],
      quiz: parsed.quiz && typeof parsed.quiz === 'object' ? parsed.quiz : {},
      poll: typeof parsed.poll === 'number' ? parsed.poll : null,
    };
  } catch {
    return { ...EMPTY };
  }
}

export function saveIssueState(issue: number, state: IssueState, total: number): void {
  try {
    window.localStorage.setItem(key(issue), JSON.stringify(state));
    const done = listDoneIssues();
    const complete = total > 0 && state.read.length >= total;
    const next = complete ? [...new Set([...done, issue])] : done.filter((n) => n !== issue);
    window.localStorage.setItem(DONE_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable */
  }
}

export function listDoneIssues(): number[] {
  try {
    const raw = window.localStorage.getItem(DONE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === 'number') : [];
  } catch {
    return [];
  }
}

/** Issues read to the end, counted backwards from the newest released number without gaps. */
export function streakFrom(latest: number, done: number[]): number {
  let streak = 0;
  for (let n = latest; n > 0 && done.includes(n); n -= 1) streak += 1;
  return streak;
}

export function quizTotals(state: IssueState): { score: number; total: number } {
  return Object.values(state.quiz).reduce((a, q) => ({ score: a.score + q.score, total: a.total + q.total }), { score: 0, total: 0 });
}
