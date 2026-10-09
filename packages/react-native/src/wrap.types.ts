import type React from "react";

import type {
  CheckForUpdateOptions,
  CheckForUpdateResult,
} from "./checkForUpdate";
import type { HotUpdaterState } from "./store";

export interface RunUpdateProcessResponse {
  status: "ROLLBACK" | "UPDATE" | "UP_TO_DATE";
  shouldForceUpdate: boolean;
  message: string | null;
  id: string;
}

export type UpdateStatus =
  | "CHECK_FOR_UPDATE"
  | "UPDATING"
  | "UPDATE_PROCESS_COMPLETED";

export type HotUpdaterFallbackComponentProps = {
  status: Exclude<UpdateStatus, "UPDATE_PROCESS_COMPLETED">;
  progress: number;
  message: string | null;
  artifactType: HotUpdaterState["artifactType"];
  details: HotUpdaterState["details"];
};

/**
 * The update flow `hotUpdater.wrap` runs when the wrapped root mounts. The
 * server, request settings, and plugins come from `HotUpdater.init`.
 */
export interface HotUpdaterWrapOptions {
  updateStrategy: "fingerprint" | "appVersion";
  fallbackComponent?: React.FC<HotUpdaterFallbackComponentProps>;
  onProgress?: (progress: number) => void;
  reloadOnForceUpdate?: boolean;
  onUpdateProcessCompleted?: (response: RunUpdateProcessResponse) => void;
}

export type InternalWrapOptions = HotUpdaterWrapOptions & {
  /** The instance's check, over the configuration of `HotUpdater.init`. */
  checkForUpdate: (
    options: Pick<CheckForUpdateOptions, "updateStrategy">,
  ) => Promise<CheckForUpdateResult | null>;
  /** Settles once `HotUpdater.init` has read this launch. */
  appReady: () => Promise<unknown>;
  onError: (error: unknown) => void;
};
