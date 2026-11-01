import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService, Identity } from './auth.service';

export type AuthRequest = Request & { identity: Identity };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthRequest>();
    req.identity = await this.auth.identity(req.headers.cookie);
    return true;
  }
}
