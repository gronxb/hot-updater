import { actionCohortRouteElements } from "./action-cohort-route-elements";
import { actionInstallRouteElements } from "./action-install-route-elements";
import { actionRecoveryRouteElements } from "./action-recovery-route-elements";
import { actionRuntimeRouteElements } from "./action-runtime-route-elements";

export const actionRouteElements = [
  ...actionInstallRouteElements,
  ...actionCohortRouteElements,
  ...actionRecoveryRouteElements,
  ...actionRuntimeRouteElements,
] as const;
