import { expect, it } from 'vitest';
import { cameraPose, orthographicBounds, smoothProgress } from './camera';
import { fixtureId, fixtureSnapshot } from './test-fixtures';
import { createSceneStore } from './scene-store';

it('focuses on the selected cell center and level height', () => {
  const layout = fixtureSnapshot().layout;
  layout.locations[0]!.grid.level = 1;
  const pose = cameraPose(layout, 'perspective', fixtureId(6));
  expect(pose.target).toEqual([2.5, 2, 1.5]); expect(pose.position).toEqual([7.5, 8, 8.5]);
});

it('top view places the camera directly above the same target and fits the viewport', () => {
  const layout = fixtureSnapshot().layout; const pose = cameraPose(layout, 'top', fixtureId(6));
  expect(pose.position[0]).toBe(pose.target[0]); expect(pose.position[2]).toBe(pose.target[2]);
  for (const aspect of [.5, 1, 2]) {
    const bounds = orthographicBounds(layout, aspect);
    expect(bounds.right - bounds.left).toBeGreaterThanOrEqual(10);
    expect(bounds.top - bounds.bottom).toBeGreaterThanOrEqual(8);
    expect((bounds.right - bounds.left) / (bounds.top - bounds.bottom)).toBeCloseTo(aspect);
  }
});

it('rejects unknown business identities and invalid resize dimensions', () => {
  expect(() => cameraPose(fixtureSnapshot().layout, 'top', fixtureId(999))).toThrow();
  expect(() => orthographicBounds(fixtureSnapshot().layout, 0)).toThrow();
});

it('bounds interpolation and ends exactly at the final pose', () => {
  expect(smoothProgress(-1)).toBe(0); expect(smoothProgress(.325)).toBeCloseTo(.5);
  expect(smoothProgress(.65)).toBe(1); expect(smoothProgress(99)).toBe(1);
});

it('rapid focus/reset requests replace one latest target, not an animation queue', () => {
  const store = createSceneStore(); store.getState().focusLocation(fixtureId(6)); store.getState().focusLocation(fixtureId(7));
  expect(store.getState().cameraRequest).toEqual({ locationId: fixtureId(7), sequence: 2 });
  store.getState().resetCamera(); expect(store.getState().cameraRequest).toEqual({ locationId: null, sequence: 3 });
});

it('search focus reveals a hidden region and filter changes clear an invisible selection', () => {
  const store = createSceneStore(); store.getState().setZoneFilter('QC'); store.getState().setViewMode('list');
  store.getState().focusLocation(fixtureId(6));
  expect(store.getState()).toMatchObject({ zoneFilter: 'ALL', viewMode: 'scene', selectedLocationId: fixtureId(6) });
  store.getState().setZoneFilter('CHARGING');
  expect(store.getState()).toMatchObject({ selectedLocationId: null, cameraRequest: { locationId: null } });
});
