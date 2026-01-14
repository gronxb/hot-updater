import useSyncExternalStoreExports from "use-sync-external-store/shim/with-selector";
import { addListener } from "./native";

export type HotUpdaterState = {
  progress: number;
  isUpdateDownloaded: boolean;
};

const { useSyncExternalStoreWithSelector } = useSyncExternalStoreExports;

const createHotUpdaterStore = () => {
  let state: HotUpdaterState = {
    progress: 0,
    isUpdateDownloaded: false,
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

  const setState = (newState: Partial<HotUpdaterState>) => {
    // Merge first, then normalize derived fields
    const nextState: HotUpdaterState = {
      ...state,
      ...newState,
    };

    // Derive `isUpdateDownloaded` from `progress` if provided.
    // If `progress` is not provided but `isUpdateDownloaded` is,
    // honor the explicit value.
    if ("progress" in newState && typeof newState.progress === "number") {
      nextState.isUpdateDownloaded = newState.progress >= 1;
    } else if (
      "isUpdateDownloaded" in newState &&
      typeof newState.isUpdateDownloaded === "boolean"
    ) {
      nextState.isUpdateDownloaded = newState.isUpdateDownloaded;
    }

    state = nextState;
    emitChange();
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  // Subscribe to native onProgress events
  // This listener is registered once when the store is created
  addListener("onProgress", setState);

  return { getSnapshot, setState, subscribe };
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
