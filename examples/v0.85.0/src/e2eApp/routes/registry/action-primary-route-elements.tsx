import { actionCapturedUpdateRouteElements } from "./action-captured-update-route-elements";
import { actionInstallRouteElements } from "./action-install-route-elements";

export const actionPrimaryRouteElements = [
  ...actionCapturedUpdateRouteElements,
  ...actionInstallRouteElements,
] as const;
