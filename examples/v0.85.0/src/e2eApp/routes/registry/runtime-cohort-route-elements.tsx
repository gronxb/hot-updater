import { runtimeCurrentCohortRoute } from "../runtime-current-cohort-route";
import { runtimeInitialCohortRoute } from "../runtime-initial-cohort-route";

export const runtimeCohortRouteElements = [
  runtimeCurrentCohortRoute,
  runtimeInitialCohortRoute,
] as const;
