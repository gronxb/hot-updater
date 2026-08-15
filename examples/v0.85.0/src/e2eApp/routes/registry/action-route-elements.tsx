import { actionCohortRouteElements } from "./action-cohort-route-elements";
import { actionPrimaryRouteElements } from "./action-primary-route-elements";
import { actionRecoveryRouteElements } from "./action-recovery-route-elements";
import { actionRuntimeRouteElements } from "./action-runtime-route-elements";

export const actionRouteElements = [
  ...actionPrimaryRouteElements,
  ...actionCohortRouteElements,
  ...actionRecoveryRouteElements,
  ...actionRuntimeRouteElements,
] as const;
