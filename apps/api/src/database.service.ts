import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@warehouse-twin/database';

@Injectable()
export class DatabaseService extends PrismaClient implements OnModuleDestroy {
  async onModuleDestroy() { await this.$disconnect(); }
}
