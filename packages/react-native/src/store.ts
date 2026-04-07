import { useSyncExternalStore } from "react";

import type {
  HotUpdaterDiffFileSnapshot,
  HotUpdaterDiffProgressDetails,
  HotUpdaterProgressEvent,
} from "./native";
import { addListener } from "./native";

export type HotUpdaterState = {
  progress: number;
  isUpdateDownloaded: boolean;
  artifactType: "archive" | "diff" | null;
  details: HotUpdaterDiffProgressDetails | null;
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

  const normalizeDiffDetails = (
    details: HotUpdaterDiffProgressDetails,
  ): HotUpdaterDiffProgressDetails => {
    const totalFilesCount = Math.max(0, details.totalFilesCount);
    const normalizedFiles: HotUpdaterDiffFileSnapshot[] = details.files
      .map((file) => ({
        order: Math.max(0, file.order),
        path: file.path,
        progress: Math.max(0, Math.min(file.progress, 1)),
        status: file.status,
      }))
      .sort((left, right) => left.order - right.order);

    return {
      completedFilesCount: Math.max(
        0,
        Math.min(details.completedFilesCount, totalFilesCount),
      ),
      files: normalizedFiles,
      totalFilesCount,
    };
  };

  const applyProgressEvent = (event: HotUpdaterProgressEvent) => {
    const nextProgress = Math.max(0, Math.min(event.progress, 1));
    const nextDetails =
      event.artifactType === "diff"
        ? normalizeDiffDetails(event.details)
        : null;

    state = {
      artifactType: event.artifactType,
      details: nextDetails,
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

    if (newState.details === undefined) {
      nextState.details = state.details;
    }

    if (nextState.artifactType !== "diff") {
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
