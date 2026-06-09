import React from "react";

import { Stack } from "../route-stack";
import { ApplyCohortInputActionScreen } from "../screens/apply-cohort-input-action-screen";
import { CohortInputScreen } from "../screens/cohort-input-screen";
import { RestoreInitialCohortActionScreen } from "../screens/restore-initial-cohort-action-screen";
import { SetCohortQaActionScreen } from "../screens/set-cohort-qa-action-screen";

export const cohortActionRouteScreens = [
  <Stack.Screen
    key="CohortInput"
    name="CohortInput"
    component={CohortInputScreen}
  />,
  <Stack.Screen
    key="ApplyCohortInputAction"
    name="ApplyCohortInputAction"
    component={ApplyCohortInputActionScreen}
  />,
  <Stack.Screen
    key="SetCohortQaAction"
    name="SetCohortQaAction"
    component={SetCohortQaActionScreen}
  />,
  <Stack.Screen
    key="RestoreInitialCohortAction"
    name="RestoreInitialCohortAction"
    component={RestoreInitialCohortActionScreen}
  />,
] as const;
