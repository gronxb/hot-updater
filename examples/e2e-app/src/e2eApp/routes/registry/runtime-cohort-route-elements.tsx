import { runtimeCurrentCohortRoute } from "../runtime-current-cohort-route";
import { runtimeInitialCohortRoute } from "../runtime-initial-cohort-route";
import { runtimeRemoteConfigRoute } from "../runtime-remote-config-route";

export const runtimeCohortRouteElements = [
  runtimeCurrentCohortRoute,
  runtimeInitialCohortRoute,
  runtimeRemoteConfigRoute,
] as const;
