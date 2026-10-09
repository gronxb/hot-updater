import { activateRemoteConfigActionRoute } from "../activate-remote-config-action-route";
import { fetchAndActivateRemoteConfigActionRoute } from "../fetch-and-activate-remote-config-action-route";
import { fetchRemoteConfigActionRoute } from "../fetch-remote-config-action-route";

export const actionRemoteConfigRouteElements = [
  fetchRemoteConfigActionRoute,
  activateRemoteConfigActionRoute,
  fetchAndActivateRemoteConfigActionRoute,
] as const;
