import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { REQUEST_ID_HEADER } from '../deps/contracts.js';
import { recordRequestError } from '../observability/http.js';
import { ApiError, renderError } from './errors.js';

/**
 * Every failure leaves as the contract error envelope with the request id; nothing else reaches the client.
 * A server error is attached to the request so its single structured request log line carries the error type,
 * scrubbed message and stack (see observability/http.ts); the filter itself writes no second line.
 */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  constructor(private readonly report: (request: FastifyRequest, error: unknown) => void = recordRequestError) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const request = host.switchToHttp().getRequest<FastifyRequest>();
    const requestId = String(request.id);
    let rendered = renderError(exception, requestId);
    if (exception instanceof HttpException && !(exception instanceof ApiError)) {
      const status = exception.getStatus();
      if (status === 404) rendered = renderError(new ApiError('access.not_found', 'route not found'), requestId);
      else if (status === 405) rendered = { status: 405, body: renderError(new ApiError('validation.schema', 'method not allowed'), requestId).body };
      else if (status === 413) rendered = renderError(new ApiError('validation.payload_too_large'), requestId);
      else if (status < 500) rendered = renderError(new ApiError('validation.schema', exception.message), requestId);
    }
    if (rendered.status >= 500) this.report(request, exception);
    reply.header(REQUEST_ID_HEADER, requestId).header('Cache-Control', 'no-store').status(rendered.status).send(rendered.body);
  }
}
