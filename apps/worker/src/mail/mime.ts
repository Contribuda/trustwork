import { randomBytes } from 'node:crypto';
import { domainToASCII } from 'node:url';
import type { OutgoingMail } from './transport.js';

/**
 * RFC 5322 / MIME rendering of one message: multipart/alternative with a plain-text and an HTML part, both UTF-8 in
 * base64 (lines of 76 characters, so no line ever needs dot-stuffing beyond the SMTP layer's own), RFC 2047 encoded
 * words for non-ASCII display names and subjects, and RFC 3834 `Auto-Submitted` for automatic mail.
 */
export class AddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AddressError';
  }
}

const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[^\s@<>()",;:\\[\]]+$/;
/** ASCII envelope form of an address: IDN domains become punycode; a non-ASCII local part is refused (no SMTPUTF8). */
export function asciiAddress(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0 || /[\r\n\0]/.test(address)) throw new AddressError('malformed address');
  const domain = domainToASCII(address.slice(at + 1));
  const result = `${address.slice(0, at)}@${domain}`;
  if (!domain || !ADDRESS.test(result) || result.length > 320) throw new AddressError('address is not a deliverable ASCII address');
  return result;
}

function base64Lines(content: string): string {
  return (Buffer.from(content, 'utf8').toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
}

/** RFC 2047 encoded words (base64), split on character boundaries so no word exceeds 75 characters. */
export function encodeHeaderText(value: string): string {
  if (/[\r\n]/.test(value)) throw new AddressError('header values must not contain line breaks');
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const words: string[] = [];
  let chunk = '';
  for (const ch of value) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}

function displayName(name: string): string {
  if (/^[A-Za-z0-9 !#$%&'*+/=?^_`{|}~-]*$/.test(name)) return name ? `"${name}"` : '';
  if (/^[\x20-\x7e]*$/.test(name)) return `"${name.replace(/(["\\])/g, '\\$1')}"`;
  return encodeHeaderText(name);
}

function headerLine(name: string, value: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(name) || /[\r\n]/.test(value)) throw new AddressError(`invalid header ${name}`);
  return `${name}: ${value}`;
}

export function renderMime(mail: OutgoingMail, date: Date = new Date()): string {
  const boundary = `=_trustwork_${randomBytes(12).toString('hex')}`;
  const from = asciiAddress(mail.from.address);
  const fromName = displayName(mail.from.name);
  const lines = [
    headerLine('From', fromName ? `${fromName} <${from}>` : from),
    headerLine('To', asciiAddress(mail.to)),
    ...(mail.replyTo ? [headerLine('Reply-To', asciiAddress(mail.replyTo))] : []),
    `Subject: ${encodeHeaderText(mail.subject)}`,
    headerLine('Date', date.toUTCString().replace('GMT', '+0000')),
    headerLine('Message-ID', `<${mail.messageId}>`),
    headerLine('MIME-Version', '1.0'),
    headerLine('Content-Language', mail.locale),
    headerLine('Auto-Submitted', 'auto-generated'),
    headerLine('X-Auto-Response-Suppress', 'All'),
    ...Object.entries(mail.headers).map(([name, value]) => headerLine(name, value)),
    headerLine('Content-Type', `multipart/alternative; boundary="${boundary}"`),
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(mail.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(mail.html),
    `--${boundary}--`,
    '',
  ];
  return lines.join('\r\n');
}
