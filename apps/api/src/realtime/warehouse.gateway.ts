import { HttpException, Inject, Injectable, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { Server, type Socket } from 'socket.io';
import type { Server as HttpServer } from 'node:http';
import { realtimeSubscribeSchema, warehouseSocketPath, type RealtimeAck } from '@warehouse-twin/contracts';
import { AuthService } from '../auth/auth.service';
import { webOrigins } from '../configure';
import { DatabaseService } from '../database.service';
import type { Prisma } from '@warehouse-twin/database';
import type { WarehouseScope } from '../warehouse-state';

type Subscription = { scope: WarehouseScope; after: number };
type Connection = { opened: number; busy: boolean; subscription?: Subscription };
const period = 250;

@Injectable()
export class WarehouseGateway implements OnModuleDestroy {
  private io?: Server;
  private timer?: NodeJS.Timeout;
  private readonly connections = new Map<Socket, Connection>();
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService, @Inject(AuthService) private readonly auth: AuthService) {}

  attach(http: HttpServer) {
    const origins = webOrigins();
    const io = new Server(http, {
      path: warehouseSocketPath, transports: ['websocket'], maxHttpBufferSize: 8192,
      allowRequest: (req, done) => {
        done(null, typeof req.headers.origin === 'string' && origins.has(req.headers.origin) && io.engine.clientsCount < 64);
      },
    });
    this.io = io;
    io.use(async (socket, next) => {
      try { await this.auth.identity(socket.request.headers.cookie); next(); }
      catch (error) { next(new Error(error instanceof HttpException && error.getStatus() === 401 ? 'UNAUTHORIZED' : 'UNAVAILABLE')); }
    });
    io.on('connection', (socket) => {
      const state: Connection = { opened: Date.now(), busy: false };
      this.connections.set(socket, state);
      socket.once('disconnect', () => this.connections.delete(socket));
      socket.on('warehouse:subscribe', (input: unknown, reply: unknown) => {
        if (typeof reply === 'function') void this.subscribe(socket, state, input, reply as (ack: RealtimeAck) => void);
      });
    });
    this.timer = setInterval(() => {
      for (const [socket, state] of this.connections) {
        if (state.busy) continue;
        if (state.subscription) void this.relay(socket, state, state.subscription);
        else if (Date.now() - state.opened > 10000) socket.disconnect(true);
      }
    }, period);
    this.timer.unref();
  }

  private async authorize(tx: Prisma.TransactionClient, socket: Socket, scope: WarehouseScope) {
    const { userId } = await this.auth.identity(socket.request.headers.cookie, tx);
    const access = await tx.warehouseAccess.findUnique({
      where: { userId_spaceId_warehouseId: { userId, ...scope } }, select: { role: true },
    });
    if (!access) throw new NotFoundException();
  }

  private async subscribe(socket: Socket, state: Connection, input: unknown, reply: (ack: RealtimeAck) => void) {
    const parsed = realtimeSubscribeSchema.safeParse(input);
    if (!parsed.success) { reply({ ok: false, code: 'BAD_REQUEST' }); return; }
    if (state.busy || state.subscription) { reply({ ok: false, code: 'BUSY' }); return; }
    const scope = { spaceId: parsed.data.spaceId.toLowerCase(), warehouseId: parsed.data.warehouseId.toLowerCase() };
    state.busy = true;
    try {
      const result = await this.db.$transaction(async (tx) => {
        await this.authorize(tx, socket, scope);
        const runtime = await tx.warehouseRuntime.findUnique({ where: { spaceId_warehouseId: scope }, select: { seq: true } });
        const watermark = runtime?.seq ?? 0;
        const after = parsed.data.after ?? watermark;
        if (after > watermark) return { ok: false, code: 'CURSOR_AHEAD' } as const;
        if (after < watermark && !await tx.warehouseEvent.findUnique({
          where: { warehouseId_seq: { warehouseId: scope.warehouseId, seq: after + 1 } }, select: { seq: true },
        })) return { ok: false, code: 'CURSOR_EXPIRED' } as const;
        return { ok: true, after } as const;
      }, { isolationLevel: 'RepeatableRead' });
      if (!result.ok) { reply(result); return; }
      if (!socket.connected) return;
      // The room name never comes from the client. A room is not a permission check.
      await socket.join(`warehouse:${scope.spaceId}:${scope.warehouseId}`);
      if (!socket.connected) return;
      reply(result);
      state.subscription = { scope, after: result.after };
    } catch (error) {
      const status = error instanceof HttpException ? error.getStatus() : 500;
      reply({ ok: false, code: status === 401 ? 'UNAUTHORIZED' : status === 404 ? 'NOT_FOUND' : 'UNAVAILABLE' });
    } finally { state.busy = false; }
  }

  private async relay(socket: Socket, state: Connection, subscription: Subscription) {
    state.busy = true;
    const { scope, after } = subscription;
    try {
      const events = await this.db.$transaction(async (tx) => {
        // Check session and grants in the same MVCC snapshot as the event page.
        await this.authorize(tx, socket, scope);
        const watermark = (await tx.warehouseRuntime.findUnique({ where: { spaceId_warehouseId: scope }, select: { seq: true } }))?.seq ?? 0;
        const page = await tx.warehouseEvent.findMany({
          where: { ...scope, seq: { gt: after } }, orderBy: { seq: 'asc' }, take: 100,
          select: { seq: true, version: true, epoch: true, tick: true, kind: true, payload: true, createdAt: true },
        });
        return after > watermark || (after < watermark && page[0]?.seq !== after + 1) ? null : page;
      }, { isolationLevel: 'RepeatableRead' });
      if (!socket.connected) return;
      if (!events) { socket.emit('warehouse:reset'); socket.disconnect(true); return; }
      if (events.length === 0) return;
      // One in-flight page per subscription. A slow peer cannot queue unlimited pages.
      const handled = await socket.timeout(4000).emitWithAck('warehouse:events', {
        ...scope, events: events.map((event) => ({ ...event, createdAt: event.createdAt.toISOString() })),
      }).catch(() => false);
      if (handled !== true) socket.disconnect(true);
      else subscription.after = events.at(-1)!.seq;
    } catch (error) {
      if (error instanceof HttpException && [401, 404].includes(error.getStatus())) {
        socket.emit('warehouse:revoked', error.getStatus());
        socket.disconnect(true);
      }
      // A transient read error keeps the cursor; the next sweep tries the same page.
    } finally { state.busy = false; }
  }

  onModuleDestroy() {
    clearInterval(this.timer);
    this.io?.disconnectSockets(true);
    this.io?.engine.close(); // Nest owns the HTTP listener.
    this.connections.clear();
  }
}
