import { cohortInputRouteScreen } from "./cohort-input-route-screen";
import { runtimeChannelInputRouteScreen } from "./runtime-channel-input-route-screen";

export const inputRouteScreens = [
  runtimeChannelInputRouteScreen,
  cohortInputRouteScreen,
] as const;
