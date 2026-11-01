const { PrismaClient } = require('@prisma/client');
const { randomBytes, scryptSync } = require('node:crypto');

const ids = {
  spaceA: '10000000-0000-4000-8000-000000000001',
  spaceB: '10000000-0000-4000-8000-000000000002',
  warehouseA: '20000000-0000-4000-8000-000000000001',
  warehouseB: '20000000-0000-4000-8000-000000000002',
};

async function seed(databaseUrl, password) {
  if (!databaseUrl || !password || password.length < 12) {
    throw new Error('DATABASE_URL and DEMO_PASSWORD (at least 12 characters) are required');
  }
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    await db.$transaction(async (tx) => {
      for (const [id, name] of [[ids.spaceA, 'Demo A'], [ids.spaceB, 'Demo B']]) {
        await tx.space.upsert({ where: { id }, update: {}, create: { id, name } });
      }
      for (const [id, spaceId, name] of [
        [ids.warehouseA, ids.spaceA, '演示仓库 A'], [ids.warehouseB, ids.spaceB, '演示仓库 B'],
      ]) {
        await tx.warehouse.upsert({ where: { id }, update: {}, create: { id, spaceId, name } });
      }
      for (const [email, role, spaceId, warehouseId] of [
        ['admin@demo.local', 'ADMIN', ids.spaceA, ids.warehouseA],
        ['operator@demo.local', 'OPERATOR', ids.spaceA, ids.warehouseA],
        ['viewer@demo.local', 'VIEWER', ids.spaceA, ids.warehouseA],
        ['other@demo.local', 'ADMIN', ids.spaceB, ids.warehouseB],
      ]) {
        const salt = randomBytes(16).toString('hex');
        const passwordHash = `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
        const user = await tx.user.upsert({ where: { email }, update: {}, create: { email, passwordHash } });
        await tx.warehouseAccess.upsert({
          where: { userId_spaceId_warehouseId: { userId: user.id, spaceId, warehouseId } },
          update: {}, create: { userId: user.id, spaceId, warehouseId, role },
        });
      }
    });
  } finally { await db.$disconnect(); }
}

module.exports = { seed, ids };
if (require.main === module) {
  seed(process.env.DATABASE_URL, process.env.DEMO_PASSWORD)
    .then(() => console.log('Seed complete (existing users and warehouse names preserved)'))
    .catch(() => { console.error('Seed failed; check database connectivity and seed configuration'); process.exitCode = 1; });
}
