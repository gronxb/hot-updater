import { runtimeReleaseStateRoute } from "../runtime-release-state-route";
import { runtimeRemoteConfigRoute } from "../runtime-remote-config-route";
import { runtimeReportedBundleRoute } from "../runtime-reported-bundle-route";

export const runtimeReleaseRouteElements = [
  runtimeReportedBundleRoute,
  runtimeReleaseStateRoute,
  runtimeRemoteConfigRoute,
] as const;
