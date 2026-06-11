import { actionRouteElements } from "./registry/action-route-elements";
import { inputRouteElements } from "./registry/input-route-elements";
import { readyRouteElements } from "./registry/ready-route-elements";
import { resultRouteElements } from "./registry/result-route-elements";
import { runtimeRouteElements } from "./registry/runtime-route-elements";
import { statusRouteElements } from "./registry/status-route-elements";

export const routeElements = [
  ...readyRouteElements,
  ...runtimeRouteElements,
  ...statusRouteElements,
  ...resultRouteElements,
  ...inputRouteElements,
  ...actionRouteElements,
] as const;
