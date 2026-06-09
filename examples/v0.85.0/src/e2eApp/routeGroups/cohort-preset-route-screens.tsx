import React from "react";

import { Stack } from "../route-stack";
import { RestoreInitialCohortActionScreen } from "../screens/restore-initial-cohort-action-screen";
import { SetCohortQaActionScreen } from "../screens/set-cohort-qa-action-screen";

export const cohortPresetRouteScreens = [
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
