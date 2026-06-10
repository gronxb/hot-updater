import { runtimeBundleRoute } from "../runtime-bundle-route";
import { runtimeChannelSwitchedRoute } from "../runtime-channel-switched-route";
import { runtimeCurrentChannelRoute } from "../runtime-current-channel-route";
import { runtimeCurrentCohortRoute } from "../runtime-current-cohort-route";
import { runtimeDefaultChannelRoute } from "../runtime-default-channel-route";
import { runtimeInitialCohortRoute } from "../runtime-initial-cohort-route";
import { runtimeLargeAssetRoute } from "../runtime-large-asset-route";
import { runtimeMarkerRoute } from "../runtime-marker-route";

export const runtimeRouteElements = [
  runtimeBundleRoute,
  runtimeMarkerRoute,
  runtimeLargeAssetRoute,
  runtimeCurrentChannelRoute,
  runtimeDefaultChannelRoute,
  runtimeChannelSwitchedRoute,
  runtimeCurrentCohortRoute,
  runtimeInitialCohortRoute,
] as const;
