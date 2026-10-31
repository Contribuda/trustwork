import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type { ApiConfig } from '../config.js';
import { ApiError } from './errors.js';
import { AUTH_REQUIREMENT, stateOf, type AuthRequirement } from './request.js';

/** Session and step-up requirements declared by `@Authenticated()` / `@Authenticated('step_up')`. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly config: ApiConfig, private readonly now: () => Date) {}

  canActivate(context: ExecutionContext): boolean {
    const requirement = this.reflector.getAllAndOverride<AuthRequirement | undefined>(AUTH_REQUIREMENT, [context.getHandler(), context.getClass()]);
    if (!requirement) return true;
    const state = stateOf(context.switchToHttp().getRequest<FastifyRequest>());
    if (!state.principal || !state.session) throw new ApiError('auth.session_invalid', 'authentication required');
    if (requirement === 'step_up' && this.now().getTime() - state.session.authenticatedAt.getTime() > this.config.session.stepUpMs) {
      throw new ApiError('auth.step_up_required', 'recent authentication required for this action');
    }
    return true;
  }
}
