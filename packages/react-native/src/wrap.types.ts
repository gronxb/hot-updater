import type React from "react";

import type { HotUpdaterError } from "./error";
import type { NotifyAppReadyResult } from "./native";
import type { HotUpdaterState } from "./store";
import type { HotUpdaterBaseURL, HotUpdaterResolver } from "./types";

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
  requestHeaders?: Record<string, string>;
  requestTimeout?: number;
  onNotifyAppReady?: (result: NotifyAppReadyResult) => void;
  onError?: (error: HotUpdaterError | Error | unknown) => void;
}

interface BaseURLConfig {
  baseURL: HotUpdaterBaseURL;
  resolver?: never;
}

interface ResolverConfig {
  resolver: HotUpdaterResolver;
  baseURL?: never;
}

type NetworkConfig = BaseURLConfig | ResolverConfig;

export type AutoUpdateOptions = CommonHotUpdaterOptions &
  NetworkConfig & {
    updateMode?: "auto";
    updateStrategy: "fingerprint" | "appVersion";
    fallbackComponent?: React.FC<HotUpdaterFallbackComponentProps>;
    onProgress?: (progress: number) => void;
    reloadOnForceUpdate?: boolean;
    onUpdateProcessCompleted?: (response: RunUpdateProcessResponse) => void;
  };

export type ManualUpdateOptions = CommonHotUpdaterOptions &
  NetworkConfig & {
    updateMode: "manual";
  };

export type HotUpdaterInitOptions = CommonHotUpdaterOptions &
  NetworkConfig & {
    analytics?: boolean;
  };

export type HotUpdaterOptions = AutoUpdateOptions | ManualUpdateOptions;

type InternalCommonOptions = {
  resolver: HotUpdaterResolver;
  requestHeaders?: Record<string, string>;
  requestTimeout?: number;
  onNotifyAppReady?: (result: NotifyAppReadyResult) => void;
  onError?: (error: HotUpdaterError | Error | unknown) => void;
};

type InternalAutoUpdateOptions = InternalCommonOptions & {
  updateStrategy: "fingerprint" | "appVersion";
  updateMode: "auto";
  fallbackComponent?: React.FC<HotUpdaterFallbackComponentProps>;
  onProgress?: (progress: number) => void;
  reloadOnForceUpdate?: boolean;
  onUpdateProcessCompleted?: (response: RunUpdateProcessResponse) => void;
};

type InternalManualUpdateOptions = InternalCommonOptions & {
  updateMode: "manual";
};

export type InternalInitOptions = InternalCommonOptions & {
  analytics?: boolean;
};

export type InternalWrapOptions =
  | InternalAutoUpdateOptions
  | InternalManualUpdateOptions;
