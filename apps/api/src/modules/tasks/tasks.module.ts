import { staffHubFromEnv } from '../identity/staff-roles.js';
import { VersionedTaskFees, type TaskFeePort } from '../billing/fees/task-adapter.js';
import { Module, type DynamicModule } from '@nestjs/common';
import type { AppContext } from '../identity/context.js';
import type { IdentityServices } from '../identity/identity.module.js';
import { ConfiguredElectronicRecords, type ElectronicRecordsPolicySource } from '../transactions/electronic-records.js';
import { NoTaskMandates, type TaskMandatePort } from './mandates.js';
import { TaskAgreementsController, TaskAssignmentsController, TaskInvitationsController, TaskOffersController, TaskRequestsController } from './tasks.controller.js';
import { TasksService } from './tasks.service.js';

export interface TasksModuleOptions {
  fees?: TaskFeePort;
  env?: NodeJS.ProcessEnv;
  /** Agent mandate check; defaults to "no mandate store", which refuses every agent request. */
  mandates?: TaskMandatePort;
  /** The hub's electronic-records policy; defaults to consent required with the engine's generic disclosure. */
  electronicRecords?: ElectronicRecordsPolicySource;
}

@Module({})
export class TasksModule {
  static forRoot(ctx: AppContext, identity: IdentityServices, options: TasksModuleOptions = {}): DynamicModule {
    const service = new TasksService(ctx, identity.principals, options.mandates ?? new NoTaskMandates(), options.electronicRecords ?? new ConfiguredElectronicRecords(), options.fees ?? new VersionedTaskFees(staffHubFromEnv(options.env ?? process.env)));
    return {
      module: TasksModule,
      controllers: [TaskRequestsController, TaskInvitationsController, TaskOffersController, TaskAgreementsController, TaskAssignmentsController],
      providers: [{ provide: TasksService, useValue: service }],
      exports: [TasksService],
    };
  }
}
