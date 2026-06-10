import { applyCohortInputActionRoute } from "../apply-cohort-input-action-route";
import { setCohortQaActionRoute } from "../set-cohort-qa-action-route";

export const actionCohortRouteElements = [
  applyCohortInputActionRoute,
  setCohortQaActionRoute,
] as const;
