import { clearUpdateLogsActionRoute } from "../clear-update-logs-action-route";
import { updateLogsRoute } from "../update-logs-route";
import { updateStatusRoute } from "../update-status-route";

export const updateDiagnosticsRouteElements = [
  updateStatusRoute,
  updateLogsRoute,
  clearUpdateLogsActionRoute,
] as const;
