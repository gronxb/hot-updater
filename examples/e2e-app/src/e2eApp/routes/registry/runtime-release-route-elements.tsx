import { runtimeReleaseStateRoute } from "../runtime-release-state-route";
import { runtimeRemoteConfigRoute } from "../runtime-remote-config-route";

export const runtimeReleaseRouteElements = [
  runtimeReleaseStateRoute,
  runtimeRemoteConfigRoute,
] as const;
