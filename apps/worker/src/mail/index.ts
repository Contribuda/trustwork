/** Transactional mail (MAIL-001): outbox intent -> localized template -> provider-neutral transport. See README.md. */
import type { MailConfig } from './config.js';
import { SmtpTransport } from './smtp.js';
import { FakeMailTransport, LogMailTransport, type MailTransport } from './transport.js';

export { mailConfigFromEnv, type MailConfig, type MailEnv } from './config.js';
export {
  registerMail, mailSettleTask, applyFeedback, submitMailFeedback, parseFeedback, deliveryIdFromMessageId, redactAddresses,
  MAIL_DELIVER_KIND, MAIL_FEEDBACK_KIND, MAIL_ENQUEUE_HANDLER, MAIL_SETTLE_TASK, MAIL_DELIVER_ATTEMPTS, MAIL_METRICS,
  type MailRuntime, type MailFeedbackEvent, type FeedbackResult, type DeliverPayload,
} from './delivery.js';
export {
  renderMail, resolveLocale, brandFor, buildLink, assertDictionariesComplete, dictionaryKeys,
  MAIL_DICTIONARIES, MAIL_LOCALES, REFERENCE_LOCALE, BRAND_OVERLAYS, TEMPLATE_SPECS, SECURITY_EVENTS, DEFAULT_LINK_PATHS, MissingTranslationError, TemplateParameterError,
  type RenderConfig, type RenderInput, type RenderedMail, type LinkKind, type MailDictionary,
} from './templates.js';
export { formatMessage, escapeHtml, placeholdersOf, MessageFormatError } from './format.js';
export { renderMime, encodeHeaderText, asciiAddress, AddressError } from './mime.js';
export { SmtpTransport, isLoopbackHost, DEFAULT_SMTP_TIMEOUTS, type SmtpConfig } from './smtp.js';
export {
  FakeMailTransport, LogMailTransport, MailTemporaryError, MailRejectedError, MailOutcomeUnknownError,
  type MailTransport, type OutgoingMail, type SendReceipt, type FakeFailure,
} from './transport.js';

/** The transport the configuration chooses. */
export function createMailTransport(config: MailConfig): MailTransport {
  if (config.transport === 'smtp') return new SmtpTransport(config.smtp!);
  if (config.transport === 'log') return new LogMailTransport();
  return new FakeMailTransport();
}
