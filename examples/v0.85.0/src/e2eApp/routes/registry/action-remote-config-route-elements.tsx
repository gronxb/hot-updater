import { activateRemoteConfigActionRoute } from "../activate-remote-config-action-route";
import { fetchRemoteConfigActionRoute } from "../fetch-remote-config-action-route";

export const actionRemoteConfigRouteElements = [
  fetchRemoteConfigActionRoute,
  activateRemoteConfigActionRoute,
] as const;
