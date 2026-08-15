import { applyCapturedUpdateActionRoute } from "../apply-captured-update-action-route";
import { captureCurrentChannelUpdateActionRoute } from "../capture-current-channel-update-action-route";

export const actionCapturedUpdateRouteElements = [
  applyCapturedUpdateActionRoute,
  captureCurrentChannelUpdateActionRoute,
] as const;
