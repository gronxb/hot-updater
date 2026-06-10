import { installCurrentChannelUpdateActionRoute } from "../install-current-channel-update-action-route";
import { installRuntimeChannelUpdateActionRoute } from "../install-runtime-channel-update-action-route";

export const actionInstallRouteElements = [
  installCurrentChannelUpdateActionRoute,
  installRuntimeChannelUpdateActionRoute,
] as const;
