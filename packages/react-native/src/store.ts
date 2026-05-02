import useSyncExternalStoreExports from "use-sync-external-store/shim/with-selector";

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

const { useSyncExternalStoreWithSelector } = useSyncExternalStoreExports;

const areDiffDetailsEqual = (
  left: HotUpdaterDiffProgressDetails | null,
  right: HotUpdaterDiffProgressDetails | null,
) => {
  if (left === right) {
    return true;
  }

  if (left === null || right === null) {
    return false;
  }

  if (
    left.totalFilesCount !== right.totalFilesCount ||
    left.completedFilesCount !== right.completedFilesCount ||
    left.files.length !== right.files.length
  ) {
    return false;
  }

  return left.files.every((leftFile, index) => {
    const rightFile = right.files[index];
    return (
      leftFile.order === rightFile.order &&
      leftFile.path === rightFile.path &&
      leftFile.progress === rightFile.progress &&
      leftFile.status === rightFile.status
    );
  });
};

const areStatesEqual = (left: HotUpdaterState, right: HotUpdaterState) => {
  return (
    left.progress === right.progress &&
    left.isUpdateDownloaded === right.isUpdateDownloaded &&
    left.artifactType === right.artifactType &&
    areDiffDetailsEqual(left.details, right.details)
  );
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

  const setState = (newState: Partial<HotUpdaterState>) => {
    // Merge first, then normalize derived fields.
    const nextState: HotUpdaterState = {
      ...state,
      ...newState,
    };

    // Derive `isUpdateDownloaded` from `progress` if provided.
    // If `progress` is not provided but `isUpdateDownloaded` is,
    // honor the explicit value.
    if ("progress" in newState && typeof newState.progress === "number") {
      nextState.progress = Math.max(0, Math.min(newState.progress, 1));
      nextState.isUpdateDownloaded = nextState.progress >= 1;
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

    if (areStatesEqual(state, nextState)) {
      return;
    }

    state = nextState;
    emitChange();
  };

  const applyProgressEvent = (event: HotUpdaterProgressEvent) => {
    setState({
      artifactType: event.artifactType,
      details:
        event.artifactType === "diff"
          ? normalizeDiffDetails(event.details)
          : null,
      progress: event.progress,
    });
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
  return useSyncExternalStoreWithSelector(
    hotUpdaterStore.subscribe,
    hotUpdaterStore.getSnapshot,
    hotUpdaterStore.getSnapshot,
    selector,
  );
};
