import { useSyncExternalStore } from "react";

import type { HotUpdaterProgressArtifactType } from "./native";
import { addListener } from "./native";

export type HotUpdaterState = {
  progress: number;
  isUpdateDownloaded: boolean;
  artifactType: HotUpdaterProgressArtifactType | null;
  totalFiles: number | null;
  completedFiles: number | null;
  currentFilePath: string | null;
  currentFileProgress: number | null;
};

const createHotUpdaterStore = () => {
  let state: HotUpdaterState = {
    progress: 0,
    isUpdateDownloaded: false,
    artifactType: null,
    totalFiles: null,
    completedFiles: null,
    currentFilePath: null,
    currentFileProgress: null,
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

    if (newState.artifactType === "archive") {
      nextState.totalFiles = newState.totalFiles ?? null;
      nextState.completedFiles = newState.completedFiles ?? null;
      nextState.currentFilePath = newState.currentFilePath ?? null;
      nextState.currentFileProgress = newState.currentFileProgress ?? null;
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
  const snapshot = useSyncExternalStore(
    hotUpdaterStore.subscribe,
    hotUpdaterStore.getSnapshot,
    hotUpdaterStore.getSnapshot,
  );

  return selector(snapshot);
};
