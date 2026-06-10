import React from "react";

import { applyCohortInputActionRoute } from "./apply-cohort-input-action-route";
import { channelActionResultRoute } from "./channel-action-result-route";
import { clearCrashHistoryActionRoute } from "./clear-crash-history-action-route";
import { cohortActionResultRoute } from "./cohort-action-result-route";
import { cohortInputRoute } from "./cohort-input-route";
import { crashHistoryCountRoute } from "./crash-history-count-route";
import { installCurrentChannelUpdateActionRoute } from "./install-current-channel-update-action-route";
import { installRuntimeChannelUpdateActionRoute } from "./install-runtime-channel-update-action-route";
import { launchCrashedBundleRoute } from "./launch-crashed-bundle-route";
import { launchStatusRoute } from "./launch-status-route";
import { readyRoute } from "./ready-route";
import { refreshRuntimeSnapshotActionRoute } from "./refresh-runtime-snapshot-action-route";
import { reloadAppActionRoute } from "./reload-app-action-route";
import { resetRuntimeChannelActionRoute } from "./reset-runtime-channel-action-route";
import { restoreInitialCohortActionRoute } from "./restore-initial-cohort-action-route";
import { runtimeBundleRoute } from "./runtime-bundle-route";
import { runtimeChannelInputRoute } from "./runtime-channel-input-route";
import { runtimeChannelSwitchedRoute } from "./runtime-channel-switched-route";
import { runtimeCurrentChannelRoute } from "./runtime-current-channel-route";
import { runtimeCurrentCohortRoute } from "./runtime-current-cohort-route";
import { runtimeDefaultChannelRoute } from "./runtime-default-channel-route";
import { runtimeInitialCohortRoute } from "./runtime-initial-cohort-route";
import { runtimeLargeAssetRoute } from "./runtime-large-asset-route";
import { runtimeMarkerRoute } from "./runtime-marker-route";
import { setCohortQaActionRoute } from "./set-cohort-qa-action-route";
import { updateActionResultRoute } from "./update-action-result-route";
import { updateStoreDownloadPathsRoute } from "./update-store-download-paths-route";
import { updateStoreDownloadedRoute } from "./update-store-downloaded-route";

export const routeElements = [
  readyRoute,
  runtimeBundleRoute,
  runtimeMarkerRoute,
  runtimeLargeAssetRoute,
  runtimeCurrentChannelRoute,
  runtimeDefaultChannelRoute,
  runtimeChannelSwitchedRoute,
  runtimeChannelInputRoute,
  runtimeCurrentCohortRoute,
  runtimeInitialCohortRoute,
  launchStatusRoute,
  launchCrashedBundleRoute,
  channelActionResultRoute,
  cohortActionResultRoute,
  crashHistoryCountRoute,
  updateActionResultRoute,
  updateStoreDownloadedRoute,
  updateStoreDownloadPathsRoute,
  cohortInputRoute,
  installCurrentChannelUpdateActionRoute,
  installRuntimeChannelUpdateActionRoute,
  applyCohortInputActionRoute,
  setCohortQaActionRoute,
  restoreInitialCohortActionRoute,
  refreshRuntimeSnapshotActionRoute,
  resetRuntimeChannelActionRoute,
  clearCrashHistoryActionRoute,
  reloadAppActionRoute,
] as const;
