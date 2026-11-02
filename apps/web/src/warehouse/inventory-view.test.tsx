import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { locationViews, findLocations } from './inventory-view';
import { InventoryDetails } from './InventoryDetails';
import { InventoryTable } from './InventoryTable';
import { fixtureId, fixtureSnapshot } from './test-fixtures';

it('maps available and empty locations without using array index as identity', () => {
  const snapshot = fixtureSnapshot();
  const before = locationViews(snapshot);
  snapshot.layout.locations.reverse();
  const after = locationViews(snapshot);
  expect(after.find((view) => view.location.id === fixtureId(6))).toEqual(before[0]);
  expect(after.find((view) => view.location.id === fixtureId(7))?.status).toBe('EMPTY');
  expect(before[0]?.status).toBe('AVAILABLE');
});

it('shows reserved stock ahead of available stock, retaining both quantities', () => {
  const snapshot = fixtureSnapshot(); const balance = snapshot.inventory.balances[0]!;
  balance.reserved = 2; balance.available = 3;
  snapshot.inventory.locationTotals[0]!.reserved = 2; snapshot.inventory.locationTotals[0]!.available = 3;
  snapshot.inventory.summary.reserved = 2; snapshot.inventory.summary.available = 3;
  const view = locationViews(snapshot)[0]!;
  expect(view.status).toBe('RESERVED'); expect(view.total.available).toBe(3);
});

it('shows HOLD ahead of reserved with no loss of batch detail', () => {
  const snapshot = fixtureSnapshot(); const balance = snapshot.inventory.balances[0]!;
  balance.reserved = 2; balance.available = 3;
  snapshot.inventory.balances.push({ ...balance, id: fixtureId(15), quality: 'HOLD', onHand: 3, reserved: 0, available: 0 });
  Object.assign(snapshot.inventory.locationTotals[0]!, { onHand: 8, reserved: 2, available: 3 });
  snapshot.inventory.summary = { onHand: 8, reserved: 2, available: 3, hold: 3 };
  const view = locationViews(snapshot)[0]!;
  expect(view.status).toBe('HOLD'); expect(view.balances).toHaveLength(2); expect(view.hold).toBe(3);
});

it('labels stock with no available quantity as unavailable rather than empty', () => {
  const snapshot = fixtureSnapshot(); snapshot.inventory.locationTotals[0]!.available = 0;
  snapshot.inventory.balances[0]!.available = 0;
  snapshot.inventory.balances[0]!.batch.expiresAt = '2000-01-01T00:00:00.000Z'; snapshot.inventory.summary.available = 0;
  expect(locationViews(snapshot)[0]?.status).toBe('UNAVAILABLE');
});

it('rejects missing quantity rows and never substitutes fake inventory', () => {
  const snapshot = fixtureSnapshot(); snapshot.inventory.locationTotals = [];
  expect(() => locationViews(snapshot)).toThrow('Missing');
});

it('renders SKU/batch/quality and numeric details for the selected business location', () => {
  const view = locationViews(fixtureSnapshot())[0]!;
  const html = renderToStaticMarkup(createElement(InventoryDetails, { view, onClose: () => {} }));
  expect(html).toContain(view.location.id); expect(html).toContain('SKU'); expect(html).toContain('RELEASED');
  expect(html).toContain('5 / 0 / 5');
});

it('keeps empty locations selectable with explicit empty text and no invented SKU', () => {
  const views = locationViews(fixtureSnapshot());
  const details = renderToStaticMarkup(createElement(InventoryDetails, { view: views[1], onClose: () => {} }));
  expect(details).toContain('空货位'); expect(details).not.toContain('fixture');
  const table = renderToStaticMarkup(createElement(InventoryTable, { views, selectedId: null, onSelect: () => {}, onFocus: () => {} }));
  expect(table).toContain('选择 L2'); expect(table).toContain('2D库存列表');
});

it('searches exact IDs/codes before partial matches and does not invent a match', () => {
  const snapshot = fixtureSnapshot();
  expect(findLocations(snapshot, ' l1 ')[0]?.id).toBe(fixtureId(6));
  expect(findLocations(snapshot, fixtureId(7))[0]?.code).toBe('L2');
  expect(findLocations(snapshot, 'L')).toHaveLength(2);
  expect(findLocations(snapshot, 'not-found')).toEqual([]); expect(findLocations(snapshot, '')).toEqual([]);
});

it('filtering creates a display view without mutating geometry, obstacles or balances', () => {
  const snapshot = fixtureSnapshot(); const original = structuredClone(snapshot);
  expect(locationViews(snapshot, 'QC')).toEqual([]);
  expect(locationViews(snapshot, 'STORAGE')).toHaveLength(2);
  expect(snapshot).toEqual(original);
});
