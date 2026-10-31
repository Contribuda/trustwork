export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, string | number | boolean | null | undefined>;
/** Structured log sink. Fields carry ids, kinds, counts and error summaries; never payloads, secrets or personal data. */
export type Logger = (level: LogLevel, message: string, fields?: LogFields) => void;

export const silentLogger: Logger = () => {};

/** One JSON object per line on stdout (stderr for warn/error). */
export function jsonLogger(clock: () => Date = () => new Date()): Logger {
  return (level, message, fields = {}) => {
    const line = JSON.stringify({ time: clock().toISOString(), level, service: 'trustwork-worker', message, ...fields });
    (level === 'warn' || level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
  };
}

/** `Name: message`, bounded; database errors add their SQLSTATE. Stacks stay out of job rows and logs by default. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    const text = `${error.name}${typeof code === 'string' ? ` [${code}]` : ''}: ${error.message}`;
    return text.length > 500 ? `${text.slice(0, 497)}...` : text;
  }
  return String(error).slice(0, 500);
}
