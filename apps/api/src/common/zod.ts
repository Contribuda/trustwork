import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';

/**
 * Zod parameter decorators: every body, query and path parameter set is validated against a contract schema
 * (strict objects reject unknown fields). A ZodError is rendered by the error filter as validation.schema /
 * validation.unknown_field. nestjs-zod is not used because its peer range stops at Nest 11.
 * The schema is wrapped under a non-reserved key: Nest treats any object with a `transform` method (every Zod schema)
 * as a pipe, and `{ schema }` as its own Standard Schema options (whose errors are not the contract envelope).
 */
type Wrapped = { zod: ZodType };
const source = (part: 'body' | 'query' | 'params') => (data: Wrapped, ctx: ExecutionContext) => data.zod.parse(ctx.switchToHttp().getRequest<FastifyRequest>()[part] ?? {});
const BodyDecorator = createParamDecorator(source('body'));
const QueryDecorator = createParamDecorator(source('query'));
const ParamsDecorator = createParamDecorator(source('params'));
export const Body = (schema: ZodType) => BodyDecorator({ zod: schema });
export const Query = (schema: ZodType) => QueryDecorator({ zod: schema });
export const Params = (schema: ZodType) => ParamsDecorator({ zod: schema });
