import { actionRouteScreens } from "./action-route-screens";
import { inputRouteScreens } from "./input-route-screens";
import { resultRouteScreens } from "./result-route-screens";
import { stateRouteScreens } from "./state-route-screens";

export const routeScreens = [
  ...stateRouteScreens,
  ...resultRouteScreens,
  ...actionRouteScreens,
  ...inputRouteScreens,
] as const;
