import { runtimeBundleRouteElements } from "./runtime-bundle-route-elements";
import { runtimeChannelRouteElements } from "./runtime-channel-route-elements";
import { runtimeCohortRouteElements } from "./runtime-cohort-route-elements";

export const runtimeRouteElements = [
  ...runtimeBundleRouteElements,
  ...runtimeChannelRouteElements,
  ...runtimeCohortRouteElements,
] as const;
