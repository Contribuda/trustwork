/** What a console form shows after a command: idle, or a localized message with its tone (built on the server). */
export type CommandState =
  | { status: 'idle' }
  | { status: 'done' | 'rejected'; message: string; tone: 'info' | 'warning' | 'error'; at: number };

export const IDLE: CommandState = { status: 'idle' };
