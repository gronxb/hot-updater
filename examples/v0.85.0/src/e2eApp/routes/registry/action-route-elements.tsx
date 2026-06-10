import { applyCohortInputActionRoute } from "../apply-cohort-input-action-route";
import { clearCrashHistoryActionRoute } from "../clear-crash-history-action-route";
import { installCurrentChannelUpdateActionRoute } from "../install-current-channel-update-action-route";
import { installRuntimeChannelUpdateActionRoute } from "../install-runtime-channel-update-action-route";
import { refreshRuntimeSnapshotActionRoute } from "../refresh-runtime-snapshot-action-route";
import { reloadAppActionRoute } from "../reload-app-action-route";
import { resetRuntimeChannelActionRoute } from "../reset-runtime-channel-action-route";
import { restoreInitialCohortActionRoute } from "../restore-initial-cohort-action-route";
import { setCohortQaActionRoute } from "../set-cohort-qa-action-route";

export const actionRouteElements = [
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
