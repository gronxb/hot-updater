import { useSyncExternalStore } from "react";

export type HotUpdaterState = {
  progress: number;
};

const createHotUpdaterStore = () => {
  let state: HotUpdaterState = {
    progress: 0,
  };

  const getState = () => {
    return state;
  };

  const listeners = new Set<() => void>();

  const emitChange = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const setState = (newState: Partial<HotUpdaterState>) => {
    state = {
      ...state,
      ...newState,
    };
    emitChange();
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  return { getState, setState, subscribe };
};

export const hotUpdaterStore = createHotUpdaterStore();

export const useHotUpdaterStore = () => {
  return useSyncExternalStore(
    hotUpdaterStore.subscribe,
    hotUpdaterStore.getState,
    hotUpdaterStore.getState,
  );
};
