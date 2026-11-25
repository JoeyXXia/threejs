import { createStore } from 'zustand/vanilla';
import { replaySeek, replayStep, type ReplayState, type Timeline } from './replay-data';

export type ReplaySpeed = 0.5 | 1 | 2;
export const replayInterval = (speed: ReplaySpeed) => 250 / speed;
type Player = {
  index: number; state: ReplayState; speed: ReplaySpeed; playing: boolean; task: string;
  seek: (index: number) => void; advance: () => void; toggle: () => void;
  setSpeed: (speed: ReplaySpeed) => void; setTask: (task: string) => void;
};
export function createReplayStore(timeline: Timeline) {
  const last = timeline.frames.length - 1;
  return createStore<Player>((set) => ({
    index: timeline.first, state: replaySeek(timeline, timeline.first), speed: 1, playing: false, task: '',
    seek: (index) => set(() => index < timeline.first || index > last || !Number.isInteger(index) ? {} :
      { index, state: replaySeek(timeline, index), playing: false }),
    advance: () => set((p) => {
      if (!p.playing || p.index === last) return { playing: false };
      const index = p.index + 1;
      return { index, state: replayStep(timeline, p.state, index), playing: index < last };
    }),
    toggle: () => set((p) => p.index === last ? { playing: false } : { playing: !p.playing }),
    setSpeed: (speed) => set({ speed }),
    setTask: (task) => set({ task }),
  }));
}
