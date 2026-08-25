import type React from "react";

import type { HotUpdaterError } from "./error";
import type { HotUpdaterHttpClient } from "./httpClient";
import type { NotifyAppReadyResult } from "./native";
import type { HotUpdaterState } from "./store";
import type { HotUpdaterBaseURL } from "./types";

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
  downloadedBytes: HotUpdaterState["downloadedBytes"];
  totalBytes: HotUpdaterState["totalBytes"];
  message: string | null;
  artifactType: HotUpdaterState["artifactType"];
  details: HotUpdaterState["details"];
};

interface CommonHotUpdaterOptions {
  /**
   * Sends app-ready transitions and same-Bundle Release adoptions to the
   * configured server. Omit or set to `false` to disable client reporting.
   */
  analytics?: boolean;
  /** Base URL of a server exposing the Hot Updater v1 client HTTP protocol. */
  baseURL: HotUpdaterBaseURL;
  requestHeaders?: Record<string, string>;
  requestTimeout?: number;
  onNotifyAppReady?: (result: NotifyAppReadyResult) => void;
  onError?: (error: HotUpdaterError | Error | unknown) => void;
}

export type AutoUpdateOptions = CommonHotUpdaterOptions & {
  updateStrategy: "fingerprint" | "appVersion";
  fallbackComponent?: React.FC<HotUpdaterFallbackComponentProps>;
  onProgress?: (progress: number) => void;
  reloadOnForceUpdate?: boolean;
  onUpdateProcessCompleted?: (response: RunUpdateProcessResponse) => void;
};

export type HotUpdaterInitOptions = CommonHotUpdaterOptions;

export type HotUpdaterOptions = AutoUpdateOptions;

type InternalCommonOptions = {
  analytics?: boolean;
  client: HotUpdaterHttpClient;
  requestHeaders?: Record<string, string>;
  requestTimeout?: number;
  onNotifyAppReady?: (result: NotifyAppReadyResult) => void;
  onError?: (error: HotUpdaterError | Error | unknown) => void;
};

type InternalAutoUpdateOptions = InternalCommonOptions & {
  updateStrategy: "fingerprint" | "appVersion";
  fallbackComponent?: React.FC<HotUpdaterFallbackComponentProps>;
  onProgress?: (progress: number) => void;
  reloadOnForceUpdate?: boolean;
  onUpdateProcessCompleted?: (response: RunUpdateProcessResponse) => void;
};

export type InternalInitOptions = InternalCommonOptions & {
  analytics?: boolean;
};

export type InternalWrapOptions = InternalAutoUpdateOptions;
