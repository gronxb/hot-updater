import { refreshRuntimeSnapshotActionRoute } from "../refresh-runtime-snapshot-action-route";
import { reloadAppActionRoute } from "../reload-app-action-route";
import { resetRuntimeChannelActionRoute } from "../reset-runtime-channel-action-route";

export const actionRuntimeRouteElements = [
  refreshRuntimeSnapshotActionRoute,
  resetRuntimeChannelActionRoute,
  reloadAppActionRoute,
] as const;
