import { applyCapturedUpdateActionRoute } from "../apply-captured-update-action-route";
import { applyCapturedUpdateInBackgroundActionRoute } from "../apply-captured-update-in-background-action-route";
import { captureCurrentChannelUpdateActionRoute } from "../capture-current-channel-update-action-route";

export const actionCapturedUpdateRouteElements = [
  applyCapturedUpdateActionRoute,
  applyCapturedUpdateInBackgroundActionRoute,
  captureCurrentChannelUpdateActionRoute,
] as const;
