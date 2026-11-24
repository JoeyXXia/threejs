import { it, expect } from 'vitest';
import { completionRate, heatColor, heatLegend, inventoryHeat } from './operations';
import { fixtureId, fixtureSnapshot } from './test-fixtures';

it('aggregates physical storage tiers at one floor cell without counting transit', () => {
  const snapshot = fixtureSnapshot();
  snapshot.layout.locations[1]!.grid = { x: 2, z: 1, level: 1 };
  snapshot.inventory.locationTotals[1]!.onHand = 7;
  snapshot.inventory.locationTotals.push({ ...snapshot.inventory.locationTotals[0]!, locationId: fixtureId(11), onHand: 90 });
  expect(inventoryHeat(snapshot)).toEqual([{ x: 2, z: 1, value: 12 }]);
});
it('does not convert an empty denominator to 0%; includes every cancellation', () => {
  expect(completionRate(0, 0)).toBeNull();
  expect(completionRate(0, 2)).toBe(0);
  expect(completionRate(2, 1)).toBeCloseTo(2 / 3);
});
it('keeps inventory and waiting scales independent and stable at bucket edges', () => {
  expect(heatColor('inventory', 9)).toBe(heatLegend.inventory[0].color);
  expect(heatColor('inventory', 10)).toBe(heatLegend.inventory[1].color);
  expect(heatColor('wait', 1000)).toBe(heatLegend.wait[0].color);
  expect(heatColor('wait', 1250)).toBe(heatLegend.wait[1].color);
  expect(heatColor('wait', 5250)).toBe(heatLegend.wait[2].color);
});
