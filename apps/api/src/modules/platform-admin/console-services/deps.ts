/**
 * Relative re-exports of the ADM-005 slice: the module imports its repository, schema and contract files directly so the
 * shared package entries stay untouched (exporting them from the barrels is integrator bookkeeping).
 */
export { consoleFlags, consoleNotifications, consoleReads, consoleViews, type ConsoleFlagRow } from '../../../../../../packages/data/src/repositories/console-services.js';
export type { ConsoleNotificationSettingRow, ConsoleSavedViewRow, FlagStage } from '../../../../../../packages/data/src/schema/console-services.js';
export {
  ActiveFlagsQuerySchema, ConsoleSearchHitSchema, ConsoleSearchQuerySchema, ConsoleSearchResultSchema, ConsoleTargetQuerySchema, ConsoleViewConfigurationSchema, ConsoleViewsQuerySchema,
  ConsoleWorkItemSchema, ConsoleWorkQuerySchema, CONSOLE_WORK_LIMIT, CreateConsoleViewCommandSchema, parseConsoleRef, RemoveConsoleViewCommandSchema, SetConsoleNotificationsCommandSchema,
  SetFlagStageCommandSchema, UpdateConsoleViewCommandSchema,
  type ActiveFlags, type ConsoleFlag, type ConsoleNotificationSettings, type ConsoleSavedView, type ConsoleSearchResult, type ConsoleViewConfiguration, type ConsoleWorkCount, type ConsoleWorkList,
  type ConsoleWorkView, type CreateConsoleViewCommand, type RemoveConsoleViewCommand, type SetConsoleNotificationsCommand, type SetFlagStageCommand, type UpdateConsoleViewCommand,
} from '../../../../../../packages/contracts/src/console-services.js';
