import { Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { IdSchema } from '../../deps/contracts.js';
import { Authenticated, Idempotent, ReqState, type RequestState } from '../../common/request.js';
import { Body, Params, Query } from '../../common/zod.js';
import { CreateCompanyCommandSchema, DirectoryPageQuerySchema, HandleKindSchema, SetHandleCommandSchema, type CreateCompanyCommand, type DirectoryPageQuery, type SetHandleCommand } from './deps.js';
import { DirectoryService } from './directory.service.js';

const IdParams = z.strictObject({ id: IdSchema });
/** Raw handle text: normalised and checked by the service, which answers not found for anything that is not a handle. */
const HandleParams = z.strictObject({ handle: z.string().min(1).max(200) });
const ResolveParams = z.strictObject({ kind: HandleKindSchema, handle: z.string().min(1).max(200) });

/**
 * Directory routes (BE-003). Lists and lookups are public projections for every caller; "my projects" and every
 * mutation need a session; mutations carry `Idempotency-Key`.
 */
@Controller('v1')
export class DirectoryController {
  constructor(@Inject(DirectoryService) private readonly directory: DirectoryService) {}

  @Post('companies') @HttpCode(201) @Authenticated() @Idempotent('company.create')
  createCompany(@Body(CreateCompanyCommandSchema) body: CreateCompanyCommand, @ReqState() state: RequestState) {
    return this.directory.createCompany(body, state);
  }

  @Get('people')
  people(@Query(DirectoryPageQuerySchema) query: DirectoryPageQuery, @ReqState() state: RequestState) {
    return this.directory.people(query, state);
  }

  @Get('companies')
  companies(@Query(DirectoryPageQuerySchema) query: DirectoryPageQuery, @ReqState() state: RequestState) {
    return this.directory.companies(query, state);
  }

  @Get('projects')
  projects(@Query(DirectoryPageQuerySchema) query: DirectoryPageQuery, @ReqState() state: RequestState) {
    return this.directory.projects(query, state);
  }

  @Get('me/projects') @Authenticated()
  myProjects(@Query(DirectoryPageQuerySchema) query: DirectoryPageQuery, @ReqState() state: RequestState) {
    return this.directory.myProjects(query, state);
  }

  @Get('people/by-handle/:handle')
  person(@Params(HandleParams) params: z.infer<typeof HandleParams>, @ReqState() state: RequestState) {
    return this.directory.lookupPerson(params.handle, state);
  }

  @Get('companies/by-handle/:handle')
  company(@Params(HandleParams) params: z.infer<typeof HandleParams>, @ReqState() state: RequestState) {
    return this.directory.lookupCompany(params.handle, state);
  }

  @Get('projects/by-handle/:handle')
  project(@Params(HandleParams) params: z.infer<typeof HandleParams>, @ReqState() state: RequestState) {
    return this.directory.lookupProject(params.handle, state);
  }

  @Get('handles/:kind/:handle')
  resolve(@Params(ResolveParams) params: z.infer<typeof ResolveParams>, @ReqState() state: RequestState) {
    return this.directory.resolve(params.kind, params.handle, state);
  }

  @Post('me/handle') @HttpCode(200) @Authenticated() @Idempotent('person.set_handle')
  setPersonHandle(@Body(SetHandleCommandSchema) body: SetHandleCommand, @ReqState() state: RequestState) {
    return this.directory.setPersonHandle(body.handle, state);
  }

  @Post('companies/:id/handle') @HttpCode(200) @Authenticated() @Idempotent('company.set_handle', 'id')
  setCompanyHandle(@Params(IdParams) params: z.infer<typeof IdParams>, @Body(SetHandleCommandSchema) body: SetHandleCommand, @ReqState() state: RequestState) {
    return this.directory.setCompanyHandle(params.id, body.handle, state);
  }

  @Post('projects/:id/handle') @HttpCode(200) @Authenticated() @Idempotent('project.set_handle', 'id')
  setProjectHandle(@Params(IdParams) params: z.infer<typeof IdParams>, @Body(SetHandleCommandSchema) body: SetHandleCommand, @ReqState() state: RequestState) {
    return this.directory.setProjectHandle(params.id, body.handle, state);
  }
}
