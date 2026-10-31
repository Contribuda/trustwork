// Types of run.mjs (the release runner) for release.test.ts.
export const SUITES: Record<'negative authorization' | 'readiness' | 'worker faults', string[]>;
export function tapCounts(tap: string): { tests: number; pass: number; fail: number; skipped: number; todo: number; cancelled: number };
export function playwrightCounts(file: string): { expected: number; unexpected: number; skipped: number; flaky: number; byProject: Record<string, Record<string, number>> } | null;
