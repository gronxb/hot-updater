import { runtimeReleaseLabelRoute } from "../runtime-release-label-route";
import { runtimeReleaseStateRoute } from "../runtime-release-state-route";
import { runtimeReportedBundleRoute } from "../runtime-reported-bundle-route";

export const runtimeReleaseRouteElements = [
  runtimeReportedBundleRoute,
  runtimeReleaseStateRoute,
  runtimeReleaseLabelRoute,
] as const;
