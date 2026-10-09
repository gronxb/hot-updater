import { refreshRuntimeSnapshotActionRoute } from "../refresh-runtime-snapshot-action-route";
import { reinitializeHotUpdaterActionRoute } from "../reinitialize-hot-updater-action-route";
import { reloadAppActionRoute } from "../reload-app-action-route";

export const actionRuntimeRouteElements = [
  refreshRuntimeSnapshotActionRoute,
  reinitializeHotUpdaterActionRoute,
  reloadAppActionRoute,
] as const;
