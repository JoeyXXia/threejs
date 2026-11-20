// Test-only IPC driver. No Nest timer or HTTP control surface is started.
const { PrismaClient } = require('../../../packages/database');
const { FleetService } = require('../../../apps/api/dist/simulation/fleet.service');

const url = new URL(process.env.INBOUND_TEST_DATABASE_URL);
if (process.env.NODE_ENV !== 'test' || !process.send || url.protocol !== 'postgresql:' || url.hostname !== '127.0.0.1'
  || url.port !== '15432' || url.pathname !== '/warehouse_twin_inbound_test') throw new Error('Isolated fleet runner fixture only');
const db = new PrismaClient({ datasourceUrl: url.toString() });
const fleet = new FleetService(db);
let pending;

process.on('message', async ({ id, op, scope, body }) => {
  try {
    let data;
    switch (op) {
      case 'assign':
        data = await fleet.assign(scope, body);
        break;
      case 'prepare':
        pending = await fleet.prepare(scope.warehouseId);
        data = pending && { ownerId: pending.ownerId, epoch: pending.epoch, tick: pending.tick, version: pending.version, effects: pending.proposal.effects };
        break;
      case 'commit':
        if (!pending || pending.scope.warehouseId !== scope.warehouseId) throw new Error('No matching prepared tick');
        await fleet.commit(pending);
        pending = undefined;
        data = true;
        break;
      default:
        throw new Error('Unknown fixture operation');
    }
    process.send({ id, data });
  } catch (error) {
    process.send({ id, error: { status: error.status ?? null, message: error.message } });
  }
});
process.once('disconnect', () => { void db.$disconnect(); });
db.$connect().then(() => process.send({ ready: true, pid: process.pid })).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
