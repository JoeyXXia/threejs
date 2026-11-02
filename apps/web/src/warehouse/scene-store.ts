import { createStore } from 'zustand/vanilla';
import type { ZoneFilter } from './inventory-view';

export type CameraMode = 'perspective' | 'top';

export function createSceneStore() {
  return createStore<{
    selectedLocationId: string | null;
    showZones: boolean;
    showServiceCells: boolean;
    viewMode: 'scene' | 'list';
    zoneFilter: ZoneFilter;
    cameraMode: CameraMode;
    cameraRequest: { locationId: string | null; sequence: number };
    selectLocation: (id: string | null) => void;
    toggleZones: () => void;
    toggleServiceCells: () => void;
    setViewMode: (mode: 'scene' | 'list') => void;
    setZoneFilter: (filter: ZoneFilter) => void;
    setCameraMode: (mode: CameraMode) => void;
    focusLocation: (id: string) => void;
    resetCamera: () => void;
  }>((set) => ({
    selectedLocationId: null, showZones: true, showServiceCells: false,
    viewMode: 'scene', zoneFilter: 'ALL', cameraMode: 'perspective', cameraRequest: { locationId: null, sequence: 0 },
    selectLocation: (id) => set({ selectedLocationId: id }),
    toggleZones: () => set((state) => ({ showZones: !state.showZones })),
    toggleServiceCells: () => set((state) => ({ showServiceCells: !state.showServiceCells })),
    setViewMode: (viewMode) => set({ viewMode }),
    setZoneFilter: (zoneFilter) => set((state) => ({ zoneFilter, selectedLocationId: null, cameraRequest: { locationId: null, sequence: state.cameraRequest.sequence + 1 } })),
    setCameraMode: (cameraMode) => set({ cameraMode }),
    focusLocation: (id) => set((state) => ({ selectedLocationId: id, zoneFilter: 'ALL', viewMode: 'scene', cameraRequest: { locationId: id, sequence: state.cameraRequest.sequence + 1 } })),
    resetCamera: () => set((state) => ({ cameraRequest: { locationId: null, sequence: state.cameraRequest.sequence + 1 } })),
  }));
}
