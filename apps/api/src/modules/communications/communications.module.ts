import { Module, type DynamicModule } from '@nestjs/common';
import { ENGINE_TEMPLATE_LANGUAGES, LocaleTagSchema } from '../../deps/contracts.js';
import type { AppContext } from '../identity/context.js';
import type { IdentityServices } from '../identity/identity.module.js';
import { staffHubFromEnv } from '../identity/staff-roles.js';
import { FakeChannelAdapter, type ChannelAdapter } from './channels.js';
import { CommunicationsService, type CommunicationsSettings } from './communications.service.js';
import { HubCommunicationsController, MeCommunicationsController, NotificationsController, ThreadsController } from './communications.controller.js';
import { NoCommsMandates, type CommsMandatePort } from './mandates.js';

export interface CommunicationsModuleOptions {
  /** Agent mandate check for agent-written messages; defaults to refusing every agent request. */
  mandates?: CommsMandatePort;
  /** Messenger and SMS adapter; only the recording fake exists (CHAN-001 adds real adapters). */
  channels?: ChannelAdapter;
  settings?: Partial<CommunicationsSettings>;
}


/**
 * Settings from the environment: `TRUSTWORK_HUB_ID` (the served hub, as for staff roles), `COMMS_HUB_LANGUAGES`
 * (comma-separated BCP 47 tags; default the seven engine languages), `COMMS_DEFAULT_LANGUAGE` (default `en`),
 * `COMMS_BRAND_NAME` (`{brand}` in template texts, default Trustwork; the mail layout around a notification applies the
 * brand overlay of MAIL-001 itself).
 */
export function communicationsSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): CommunicationsSettings {
  const languages = env.COMMS_HUB_LANGUAGES?.trim() ? env.COMMS_HUB_LANGUAGES.split(',').map((t) => t.trim()).filter(Boolean) : [...ENGINE_TEMPLATE_LANGUAGES];
  for (const tag of languages) if (!LocaleTagSchema.safeParse(tag).success) throw new Error(`COMMS_HUB_LANGUAGES: ${tag} is not a BCP 47 language tag`);
  const defaultLanguage = env.COMMS_DEFAULT_LANGUAGE?.trim() || 'en';
  if (!languages.includes(defaultLanguage)) throw new Error(`COMMS_DEFAULT_LANGUAGE ${defaultLanguage} is not among COMMS_HUB_LANGUAGES`);
  const brand = env.COMMS_BRAND_NAME?.trim() || 'Trustwork';
  return { hubId: staffHubFromEnv(env), hubLanguages: languages, defaultLanguage, replyTokenDays: 30, brandFor: () => brand };
}

@Module({})
export class CommunicationsModule {
  static forRoot(ctx: AppContext, identity: IdentityServices, options: CommunicationsModuleOptions = {}, env: NodeJS.ProcessEnv = process.env): DynamicModule {
    const settings = { ...communicationsSettingsFromEnv(env), ...options.settings };
    const service = new CommunicationsService(ctx, identity.principals, options.mandates ?? new NoCommsMandates(), options.channels ?? new FakeChannelAdapter(), settings);
    return {
      module: CommunicationsModule,
      controllers: [ThreadsController, NotificationsController, MeCommunicationsController, HubCommunicationsController],
      providers: [{ provide: CommunicationsService, useValue: service }],
      exports: [CommunicationsService],
    };
  }
}
