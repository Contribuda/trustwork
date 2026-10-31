import { Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { IdSchema } from '../../deps/contracts.js';
import { Authenticated, Idempotent, ReqState, type RequestState } from '../../common/request.js';
import { Body, Params, Query } from '../../common/zod.js';
import { CompleteUploadCommandSchema, CopyFileCommandSchema, DeleteFileCommandSchema, FileListQuerySchema, MoveFileCommandSchema, StartUploadCommandSchema } from './deps.js';
import { FilesService } from './files.service.js';

const IdParams = z.strictObject({ id: IdSchema });
type P<T extends z.ZodType> = z.infer<T>;

/**
 * Files and attachments (FILE-001) under `/v1/files`. Every route needs a session; reads of a file somebody may not know
 * about answer "not found". Bytes never pass through the API: uploads and downloads use short-lived signed URLs.
 */
@Controller('v1/files')
export class FilesController {
  constructor(@Inject(FilesService) private readonly files: FilesService) {}

  @Get() @Authenticated()
  list(@Query(FileListQuerySchema) query: P<typeof FileListQuerySchema>, @ReqState() state: RequestState) {
    return this.files.list(query, state);
  }

  @Post('uploads') @HttpCode(201) @Authenticated() @Idempotent('file.upload_start')
  startUpload(@Body(StartUploadCommandSchema) body: P<typeof StartUploadCommandSchema>, @ReqState() state: RequestState) {
    return this.files.startUpload(body, state);
  }

  @Get(':id') @Authenticated()
  get(@Params(IdParams) params: P<typeof IdParams>, @ReqState() state: RequestState) {
    return this.files.get(params.id, state);
  }

  @Get(':id/download') @Authenticated()
  download(@Params(IdParams) params: P<typeof IdParams>, @ReqState() state: RequestState) {
    return this.files.downloadUrl(params.id, state);
  }

  @Post(':id/complete') @HttpCode(200) @Authenticated() @Idempotent('file.upload_complete', 'id')
  complete(@Params(IdParams) params: P<typeof IdParams>, @Body(CompleteUploadCommandSchema) body: P<typeof CompleteUploadCommandSchema>, @ReqState() state: RequestState) {
    return this.files.completeUpload(params.id, body, state);
  }

  @Post(':id/copy') @HttpCode(201) @Authenticated() @Idempotent('file.copy', 'id')
  copy(@Params(IdParams) params: P<typeof IdParams>, @Body(CopyFileCommandSchema) body: P<typeof CopyFileCommandSchema>, @ReqState() state: RequestState) {
    return this.files.copy(params.id, body, state);
  }

  @Post(':id/move') @HttpCode(201) @Authenticated() @Idempotent('file.move', 'id')
  move(@Params(IdParams) params: P<typeof IdParams>, @Body(MoveFileCommandSchema) body: P<typeof MoveFileCommandSchema>, @ReqState() state: RequestState) {
    return this.files.move(params.id, body, state);
  }

  @Post(':id/delete') @HttpCode(200) @Authenticated() @Idempotent('file.delete', 'id')
  remove(@Params(IdParams) params: P<typeof IdParams>, @Body(DeleteFileCommandSchema) body: P<typeof DeleteFileCommandSchema>, @ReqState() state: RequestState) {
    return this.files.remove(params.id, body, state);
  }
}
