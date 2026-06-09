import { cohortInputRouteScreens } from "./cohort-input-route-screens";
import { cohortPresetRouteScreens } from "./cohort-preset-route-screens";
import { installActionRouteScreens } from "./install-action-route-screens";
import { launchStateAssertionRouteScreens } from "./launch-state-assertion-route-screens";
import { resultAssertionRouteScreens } from "./result-assertion-route-screens";
import { runtimeBundleAssertionRouteScreens } from "./runtime-bundle-assertion-route-screens";
import { runtimeChannelActionRouteScreens } from "./runtime-channel-action-route-screens";
import { runtimeChannelAssertionRouteScreens } from "./runtime-channel-assertion-route-screens";
import { runtimeCohortAssertionRouteScreens } from "./runtime-cohort-assertion-route-screens";
import { runtimeCommandRouteScreens } from "./runtime-command-route-screens";
import { updateStoreAssertionRouteScreens } from "./update-store-assertion-route-screens";

export const routeScreens = [
  ...runtimeBundleAssertionRouteScreens,
  ...runtimeChannelAssertionRouteScreens,
  ...runtimeCohortAssertionRouteScreens,
  ...launchStateAssertionRouteScreens,
  ...updateStoreAssertionRouteScreens,
  ...resultAssertionRouteScreens,
  ...installActionRouteScreens,
  ...runtimeCommandRouteScreens,
  ...runtimeChannelActionRouteScreens,
  ...cohortInputRouteScreens,
  ...cohortPresetRouteScreens,
] as const;
