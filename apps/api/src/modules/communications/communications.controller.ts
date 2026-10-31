import { Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import {
  ActivateTemplateVersionCommandSchema, CreateChannelGrantCommandSchema, DraftTemplateVersionCommandSchema, IdSchema, NotificationListQuerySchema, NotificationTemplateKeySchema,
  OpenThreadCommandSchema, PostMessageCommandSchema, SetNotificationPreferenceCommandSchema, ThreadListQuerySchema,
} from '../../deps/contracts.js';
import { Authenticated, Idempotent, ReqState, type RequestState } from '../../common/request.js';
import { Body, Params, Query } from '../../common/zod.js';
import { CommunicationsService } from './communications.service.js';

const IdParams = z.strictObject({ id: IdSchema });
const KeyParams = z.strictObject({ key: NotificationTemplateKeySchema });
const VersionParams = z.strictObject({ key: NotificationTemplateKeySchema, version: z.coerce.number().int().min(1).max(10_000) });
type P<T extends z.ZodType> = z.infer<T>;

/**
 * Context threads (COMMS-001) under `/v1/threads`. Threads are listed per context only: there is no generic inbox.
 * Parties of the context read and write; everyone else gets not found.
 */
@Controller('v1/threads')
export class ThreadsController {
  constructor(@Inject(CommunicationsService) private readonly comms: CommunicationsService) {}

  @Get() @Authenticated()
  list(@Query(ThreadListQuerySchema) query: P<typeof ThreadListQuerySchema>, @ReqState() state: RequestState) {
    return this.comms.listThreads({ kind: query.contextKind, id: query.contextId }, state);
  }

  @Post() @HttpCode(201) @Authenticated() @Idempotent('comms.thread_open')
  open(@Body(OpenThreadCommandSchema) body: P<typeof OpenThreadCommandSchema>, @ReqState() state: RequestState) {
    return this.comms.openThread(body, state);
  }

  @Get(':id') @Authenticated()
  get(@Params(IdParams) params: P<typeof IdParams>, @ReqState() state: RequestState) {
    return this.comms.getThread(params.id, state);
  }

  @Post(':id/messages') @HttpCode(201) @Authenticated() @Idempotent('comms.message_post', 'id')
  post(@Params(IdParams) params: P<typeof IdParams>, @Body(PostMessageCommandSchema) body: P<typeof PostMessageCommandSchema>, @ReqState() state: RequestState) {
    return this.comms.postMessage(params.id, body, state);
  }
}

/** The bell and the notifications page: the person's own notifications, re-checked against their current rights. */
@Controller('v1/notifications')
export class NotificationsController {
  constructor(@Inject(CommunicationsService) private readonly comms: CommunicationsService) {}

  @Get() @Authenticated()
  list(@Query(NotificationListQuerySchema) query: P<typeof NotificationListQuerySchema>, @ReqState() state: RequestState) {
    return this.comms.listNotifications(query, state);
  }

  @Post('read-all') @HttpCode(200) @Authenticated() @Idempotent('comms.notification_read_all')
  readAll(@ReqState() state: RequestState) {
    return this.comms.markAllRead(state);
  }

  @Post(':id/read') @HttpCode(200) @Authenticated() @Idempotent('comms.notification_read', 'id')
  read(@Params(IdParams) params: P<typeof IdParams>, @ReqState() state: RequestState) {
    return this.comms.markRead(params.id, state);
  }
}

/** The person's notification preferences, mail unsubscribe and external channel grants. */
@Controller('v1/me')
export class MeCommunicationsController {
  constructor(@Inject(CommunicationsService) private readonly comms: CommunicationsService) {}

  @Get('notification-preferences') @Authenticated()
  preferences(@ReqState() state: RequestState) {
    return this.comms.getPreferences(state);
  }

  @Post('notification-preferences') @HttpCode(200) @Authenticated() @Idempotent('comms.preference_set')
  setPreference(@Body(SetNotificationPreferenceCommandSchema) body: P<typeof SetNotificationPreferenceCommandSchema>, @ReqState() state: RequestState) {
    return this.comms.setPreference(body, state);
  }

  @Post('mail-unsubscribe') @HttpCode(200) @Authenticated() @Idempotent('comms.mail_unsubscribe')
  unsubscribe(@ReqState() state: RequestState) {
    return this.comms.unsubscribe(state);
  }

  @Get('channel-grants') @Authenticated()
  grants(@ReqState() state: RequestState) {
    return this.comms.listGrants(state);
  }

  @Post('channel-grants') @HttpCode(201) @Authenticated('step_up') @Idempotent('comms.channel_grant_create')
  grant(@Body(CreateChannelGrantCommandSchema) body: P<typeof CreateChannelGrantCommandSchema>, @ReqState() state: RequestState) {
    return this.comms.createGrant(body, state);
  }

  @Post('channel-grants/:id/revoke') @HttpCode(200) @Authenticated() @Idempotent('comms.channel_grant_revoke', 'id')
  revoke(@Params(IdParams) params: P<typeof IdParams>, @ReqState() state: RequestState) {
    return this.comms.revokeGrant(params.id, state);
  }
}

/** Hub staff: versioned notification templates (editors draft, operations activate) and delivery counts. */
@Controller('v1/hub')
export class HubCommunicationsController {
  constructor(@Inject(CommunicationsService) private readonly comms: CommunicationsService) {}

  @Get('message-templates/:key') @Authenticated()
  versions(@Params(KeyParams) params: P<typeof KeyParams>, @ReqState() state: RequestState) {
    return this.comms.listTemplateVersions(params.key, state);
  }

  @Post('message-templates/:key/drafts') @HttpCode(200) @Authenticated() @Idempotent('comms.template_draft', 'key')
  draft(@Params(KeyParams) params: P<typeof KeyParams>, @Body(DraftTemplateVersionCommandSchema) body: P<typeof DraftTemplateVersionCommandSchema>, @ReqState() state: RequestState) {
    return this.comms.draftTemplate(params.key, body, state);
  }

  @Post('message-templates/:key/versions/:version/activate') @HttpCode(200) @Authenticated() @Idempotent('comms.template_activate', 'key')
  activate(@Params(VersionParams) params: P<typeof VersionParams>, @Body(ActivateTemplateVersionCommandSchema) body: P<typeof ActivateTemplateVersionCommandSchema>, @ReqState() state: RequestState) {
    return this.comms.activateTemplate(params.key, params.version, body, state);
  }

  @Get('deliveries/counts') @Authenticated()
  counts(@ReqState() state: RequestState) {
    return this.comms.deliveryCounts(state);
  }
}
