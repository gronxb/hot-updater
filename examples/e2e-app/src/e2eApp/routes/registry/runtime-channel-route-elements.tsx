import { runtimeChannelSwitchedRoute } from "../runtime-channel-switched-route";
import { runtimeCurrentChannelRoute } from "../runtime-current-channel-route";
import { runtimeDefaultChannelRoute } from "../runtime-default-channel-route";

export const runtimeChannelRouteElements = [
  runtimeCurrentChannelRoute,
  runtimeDefaultChannelRoute,
  runtimeChannelSwitchedRoute,
] as const;
