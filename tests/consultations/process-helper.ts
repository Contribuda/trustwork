import { fork } from 'node:child_process';
import { once } from 'node:events';
import type { PoolConfig } from 'pg';

export interface SentEffects { mail: { id: string; text: string }[]; channels: { id: string; text: string }[] }
export async function reminderProcess(config: PoolConfig, hubId: string) {
  const child = fork(new URL('./fixtures/reminder-worker.ts', import.meta.url), [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let next = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  child.on('message', (message: { id?: number; result?: unknown; error?: string; event?: string }) => {
    if (message.event) { child.emit(message.event); return; }
    const waiter = pending.get(message.id!);
    pending.delete(message.id!);
    if (message.error) waiter?.reject(new Error(message.error)); else waiter?.resolve(message.result);
  });
  child.on('exit', () => { for (const waiter of pending.values()) waiter.reject(new Error('recording worker exited')); pending.clear(); });
  function command<T>(action: string, args: Record<string, unknown> = {}): Promise<T> {
    const id = ++next;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: (value) => resolve(value as T), reject });
      child.send({ id, action, ...args });
    });
  }
  await command('init', { config, hubId });
  return {
    command,
    atEffect: () => once(child, 'at-effect', { signal: AbortSignal.timeout(20_000) }),
    release: () => { child.send({ id: 0, action: 'release' }); },
    async close() { if (child.connected) { const exited = once(child, 'exit'); await command('close'); await exited; } },
  };
}
