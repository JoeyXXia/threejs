import { Body, Controller, Get, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { AuthGuard, AuthRequest } from './auth.guard';
import { objectInput, textInput } from './input';
import { DatabaseService } from '../database.service';

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(DatabaseService) private readonly db: DatabaseService,
  ) {}

  @Post('login')
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const input = objectInput(body, ['email', 'password']);
    const email = textInput(input.email, 3, 254).toLowerCase();
    // Do not trim passwords: whitespace is part of the credential.
    if (typeof input.password !== 'string' || input.password.length < 1 || input.password.length > 256) {
      textInput(undefined, 1, 256);
    }
    const result = await this.auth.login(email, input.password as string, req.ip ?? 'unknown');
    res.setHeader('Set-Cookie', this.auth.cookie(result.token, result.ttl));
    return { user: result.user, expiresAt: result.expiresAt };
  }

  @Get('me')
  @UseGuards(AuthGuard)
  async me(@Req() req: AuthRequest) {
    const access = await this.db.warehouseAccess.findMany({
      where: { userId: req.identity.userId },
      include: { warehouse: true },
      orderBy: { warehouseId: 'asc' },
    });
    return {
      user: { id: req.identity.userId, email: req.identity.email },
      expiresAt: req.identity.expiresAt,
      warehouses: access.map(({ role, warehouse }) => ({ id: warehouse.id, spaceId: warehouse.spaceId, name: warehouse.name, version: warehouse.version, role })),
    };
  }

  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.headers.cookie);
    res.setHeader('Set-Cookie', this.auth.cookie('', 0));
    return { loggedOut: true };
  }
}
