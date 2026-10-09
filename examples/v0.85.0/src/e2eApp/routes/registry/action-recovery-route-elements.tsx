import { clearCrashHistoryActionRoute } from "../clear-crash-history-action-route";
import { resetRuntimeChannelActionRoute } from "../reset-runtime-channel-action-route";
import { restoreInitialCohortActionRoute } from "../restore-initial-cohort-action-route";

export const actionRecoveryRouteElements = [
  restoreInitialCohortActionRoute,
  clearCrashHistoryActionRoute,
  resetRuntimeChannelActionRoute,
] as const;
