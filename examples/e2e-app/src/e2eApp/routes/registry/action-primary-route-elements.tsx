import { actionCapturedUpdateRouteElements } from "./action-captured-update-route-elements";
import { actionInstallRouteElements } from "./action-install-route-elements";
import { actionRemoteConfigRouteElements } from "./action-remote-config-route-elements";

export const actionPrimaryRouteElements = [
  ...actionCapturedUpdateRouteElements,
  ...actionInstallRouteElements,
  ...actionRemoteConfigRouteElements,
] as const;
