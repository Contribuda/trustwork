// Types of smtp-sink.mjs (a plain module so it runs in a Node container without a build step).
import type { Server } from 'node:http';

export interface SinkMessageView { to: string[]; from: string; subject: string | null; language: string | null; text: string | null; links: string[]; receivedAt: string }
export interface ParsedSinkMessage { headers: Map<string, string>; subject: string; language: string | null; text: string; html: string }
export function parseMessage(raw: string): ParsedSinkMessage | null;
export function linksIn(text: string): string[];
export class ReleaseSmtpSink {
  messages: Array<{ from: string; to: string[]; raw: string; receivedAt: string }>;
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
  to(address: string): SinkMessageView[];
}
export function createReader(sink: ReleaseSmtpSink): Server;
