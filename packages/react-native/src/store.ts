import { useSyncExternalStore } from "react";

import type {
  HotUpdaterManifestProgressDetails,
  HotUpdaterProgressEvent,
} from "./native";
import { addListener } from "./native";

export type HotUpdaterState = {
  progress: number;
  isUpdateDownloaded: boolean;
  artifactType: "manifest" | null;
  details: HotUpdaterManifestProgressDetails | null;
};

const createHotUpdaterStore = () => {
  let state: HotUpdaterState = {
    progress: 0,
    isUpdateDownloaded: false,
    artifactType: null,
    details: null,
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

  const normalizeManifestDetails = (
    event: HotUpdaterProgressEvent,
  ): HotUpdaterManifestProgressDetails | null => {
    if (event.details) {
      return {
        completedFiles: Math.max(
          0,
          Math.min(event.details.completedFiles, event.details.totalFiles),
        ),
        currentFilePath: event.details.currentFilePath ?? null,
        currentFileProgress:
          typeof event.details.currentFileProgress === "number"
            ? Math.max(0, Math.min(event.details.currentFileProgress, 1))
            : null,
        totalFiles: Math.max(0, event.details.totalFiles),
      };
    }

    if (
      event.artifactType !== "manifest" ||
      typeof event.totalFiles !== "number" ||
      typeof event.completedFiles !== "number"
    ) {
      return null;
    }

    return {
      completedFiles: Math.max(
        0,
        Math.min(event.completedFiles, event.totalFiles),
      ),
      currentFilePath: event.currentFilePath ?? null,
      currentFileProgress:
        typeof event.currentFileProgress === "number"
          ? Math.max(0, Math.min(event.currentFileProgress, 1))
          : null,
      totalFiles: Math.max(0, event.totalFiles),
    };
  };

  const applyProgressEvent = (event: HotUpdaterProgressEvent) => {
    const manifestDetails = normalizeManifestDetails(event);
    const nextProgress =
      typeof event.progress === "number" ? event.progress : state.progress;

    state = {
      artifactType: manifestDetails ? "manifest" : null,
      details: manifestDetails,
      isUpdateDownloaded: nextProgress >= 1,
      progress: nextProgress,
    };

    emitChange();
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

    if (newState.artifactType !== "manifest") {
      nextState.artifactType = null;
    }

    if (newState.details === undefined) {
      nextState.details = state.details;
    }

    if (nextState.artifactType !== "manifest") {
      nextState.details = null;
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
  addListener("onProgress", applyProgressEvent);

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
