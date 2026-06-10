import { runtimeBundleRoute } from "../runtime-bundle-route";
import { runtimeLargeAssetRoute } from "../runtime-large-asset-route";
import { runtimeMarkerRoute } from "../runtime-marker-route";

export const runtimeBundleRouteElements = [
  runtimeBundleRoute,
  runtimeMarkerRoute,
  runtimeLargeAssetRoute,
] as const;
