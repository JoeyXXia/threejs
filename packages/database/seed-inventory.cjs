const { createHash } = require('node:crypto');
const layout = require('../../data/layouts/demo-v1.json');

function stableId(key) {
  const hex = createHash('sha256').update(`warehouse-twin:${key}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function seedInventory(tx, spaceId, warehouseId) {
  // Serialize seed and capacity decisions per warehouse. No browser-derived balances.
  await tx.$queryRaw`SELECT id FROM "Warehouse" WHERE id = ${warehouseId}::uuid FOR UPDATE`;
  const scope = { spaceId, warehouseId };
  const id = (key) => stableId(`${warehouseId}:${key}`);
  const layoutId = id('layout:1');
  const storage = [];
  for (const rack of layout.racks) {
    for (let z = 0; z < rack.sizeZ; z++) for (let level = 0; level < rack.levels; level++) {
      storage.push({
        code: `${rack.code}-${z + 1}-L${level + 1}`, kind: 'STORAGE', zone: rack.zone, rack: rack.code,
        gridX: rack.gridX, gridZ: rack.gridZ + z, level,
        serviceX: rack.gridX - 1, serviceZ: rack.gridZ + z, capacity: 40,
      });
    }
  }
  const locations = [...storage, ...layout.stations.map((station) => ({
    ...station, level: 0, serviceX: station.gridX, serviceZ: station.gridZ, rack: null,
  }))];

  if (!await tx.layoutVersion.findUnique({ where: { id: layoutId } })) {
    const { version, width, depth, cellSize, originX, originZ } = layout;
    await tx.layoutVersion.create({ data: { id: layoutId, ...scope, version, width, depth, cellSize, originX, originZ } });
    for (const zone of layout.zones) {
      await tx.layoutZone.create({ data: { id: id(`zone:${zone.code}`), ...scope, layoutId, ...zone } });
    }
    for (const { zone, ...rack } of layout.racks) {
      await tx.rack.create({ data: { id: id(`rack:${rack.code}`), ...scope, layoutId, zoneId: id(`zone:${zone}`), ...rack } });
    }
    for (const { code, kind, zone, rack, ...placement } of locations) {
      const locationId = id(`location:${code}`);
      await tx.location.create({ data: { id: locationId, ...scope, code, kind } });
      await tx.layoutLocation.create({ data: {
        ...scope, layoutId, locationId, zoneId: id(`zone:${zone}`), rackId: rack ? id(`rack:${rack}`) : null, ...placement,
      } });
    }
    await tx.layoutVersion.update({ where: { id: layoutId }, data: { status: 'PUBLISHED' } });
    await tx.warehouse.update({ where: { id: warehouseId }, data: { activeLayoutId: layoutId } });
  }

  for (const code of ['SKU-A', 'SKU-B']) {
    const skuId = id(`sku:${code}`);
    await tx.sku.upsert({ where: { id: skuId }, update: {}, create: { id: skuId, ...scope, code, name: `合成商品 ${code}`, unit: 'piece' } });
    await tx.batch.upsert({ where: { id: id(`batch:${code}`) }, update: {}, create: {
      id: id(`batch:${code}`), ...scope, skuId, code: 'B01', expiresAt: new Date('2030-01-01T00:00:00Z'),
    } });
  }
  const openings = storage.slice(0, 10).map((location, index) => ({ code: location.code, sku: index % 2 ? 'SKU-B' : 'SKU-A', quantity: index + 1, quality: 'RELEASED' }));
  openings.push({ code: 'QC-01', sku: 'SKU-A', quantity: 7, quality: 'HOLD' });
  for (const opening of openings) {
    const businessKey = `opening:demo-v1:${opening.code}`;
    const key = { spaceId, warehouseId, businessKey };
    if (await tx.inventoryMovement.findUnique({ where: { spaceId_warehouseId_businessKey: key } })) continue;
    const stock = { ...scope, locationId: id(`location:${opening.code}`), skuId: id(`sku:${opening.sku}`), batchId: id(`batch:${opening.sku}`), quality: opening.quality };
    await tx.inventoryBalance.create({ data: { id: id(`balance:${businessKey}`), ...stock, onHand: opening.quantity, reserved: 0 } });
    await tx.inventoryMovement.create({ data: {
      id: id(`movement:${businessKey}`), ...key, skuId: stock.skuId, batchId: stock.batchId,
      kind: 'OPENING', destinationLocationId: stock.locationId, destinationQuality: stock.quality,
      quantity: opening.quantity, actorType: 'SEED', actorId: 'seed:demo-v1',
      reason: 'Synthetic opening stock', reference: 'data/layouts/demo-v1.json',
    } });
  }
}

module.exports = { seedInventory, stableId };
