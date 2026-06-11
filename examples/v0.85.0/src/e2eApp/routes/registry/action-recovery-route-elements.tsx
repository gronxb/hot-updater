import { clearCrashHistoryActionRoute } from "../clear-crash-history-action-route";
import { restoreInitialCohortActionRoute } from "../restore-initial-cohort-action-route";

export const actionRecoveryRouteElements = [
  restoreInitialCohortActionRoute,
  clearCrashHistoryActionRoute,
] as const;
