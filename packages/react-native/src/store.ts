import useSyncExternalStoreExports from "use-sync-external-store/shim/with-selector";
export type HotUpdaterState = {
  progress: number;
  isBundleUpdated: boolean;
};

const { useSyncExternalStoreWithSelector } = useSyncExternalStoreExports;

const createHotUpdaterStore = () => {
  let state: HotUpdaterState = {
    progress: 0,
    isBundleUpdated: false,
  };

  const getSnapshot = () => {
    return state;
  };

  const listeners = new Set<() => void>();

  const emitChange = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const setProgress = (progress: number) => {
    state = {
      isBundleUpdated: progress === 1,
      progress,
    };
    emitChange();
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  return { getSnapshot, setProgress, subscribe };
};

export const hotUpdaterStore = createHotUpdaterStore();

export const useHotUpdaterStore = <T = HotUpdaterState>(
  selector: (snapshot: HotUpdaterState) => T = (snapshot) => snapshot as T,
) => {
  return useSyncExternalStoreWithSelector(
    hotUpdaterStore.subscribe,
    hotUpdaterStore.getSnapshot,
    hotUpdaterStore.getSnapshot,
    selector,
  );
};
