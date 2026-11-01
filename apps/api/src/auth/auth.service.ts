import { HttpException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseService } from '../database.service';

const derive = promisify(scrypt);
export const cookieName = 'wt_session';
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

export type Identity = { userId: string; email: string; expiresAt: Date };

@Injectable()
export class AuthService {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  async login(email: string, password: string, ip: string) {
    const now = Date.now();
    // Bounded, single-process demo throttle; no Redis or distributed guarantees.
    for (const [key, entry] of this.attempts) if (entry.resetAt <= now) this.attempts.delete(key);
    let entry = this.attempts.get(ip);
    if (!entry) {
      if (this.attempts.size >= 1000) throw new HttpException('Try later', 429);
      entry = { count: 0, resetAt: now + 60_000 };
      this.attempts.set(ip, entry);
    }
    if (++entry.count > 10) throw new HttpException('Try later', 429);
    const user = await this.db.user.findUnique({ where: { email } });
    const [, salt = 'missing-user', stored = '00'.repeat(64)] = (user?.passwordHash ?? '').split(':');
    const derived = await derive(password, salt, 64) as Buffer;
    const expected = Buffer.from(stored, 'hex');
    if (!user || expected.length !== derived.length || !timingSafeEqual(expected, derived)) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const ttl = Number(process.env.SESSION_TTL_SECONDS ?? 3600);
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 86400) throw new Error('Invalid session TTL');
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(now + ttl * 1000);
    await this.db.session.create({ data: { userId: user.id, tokenHash: digest(token), expiresAt } });
    return { token, expiresAt, ttl, user: { id: user.id, email: user.email } };
  }

  token(cookie: string | undefined) {
    const token = cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    return token && /^[0-9a-f]{64}$/.test(token) ? token : undefined;
  }

  async identity(cookie: string | undefined): Promise<Identity> {
    const token = this.token(cookie);
    if (!token) throw new UnauthorizedException();
    const session = await this.db.session.findUnique({ where: { tokenHash: digest(token) }, include: { user: true } });
    if (!session || session.expiresAt.getTime() <= Date.now()) throw new UnauthorizedException();
    return { userId: session.userId, email: session.user.email, expiresAt: session.expiresAt };
  }

  async logout(cookie: string | undefined) {
    const token = this.token(cookie);
    if (token) await this.db.session.deleteMany({ where: { tokenHash: digest(token) } });
  }

  cookie(value: string, ttl: number) {
    const secure = process.env.NODE_ENV === 'production' || process.env.SESSION_SECURE === 'true';
    return `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ttl}${secure ? '; Secure' : ''}`;
  }
}
