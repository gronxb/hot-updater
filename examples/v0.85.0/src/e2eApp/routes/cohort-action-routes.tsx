import React from "react";

import { Stack } from "../route-stack";
import { ApplyCohortInputActionScreen } from "../screens/apply-cohort-input-action-screen";
import { RestoreInitialCohortActionScreen } from "../screens/restore-initial-cohort-action-screen";
import { SetCohortQaActionScreen } from "../screens/set-cohort-qa-action-screen";

export const cohortActionRoutes = (
  <>
    <Stack.Screen
      name="ApplyCohortInputAction"
      component={ApplyCohortInputActionScreen}
    />
    <Stack.Screen
      name="RestoreInitialCohortAction"
      component={RestoreInitialCohortActionScreen}
    />
    <Stack.Screen
      name="SetCohortQaAction"
      component={SetCohortQaActionScreen}
    />
  </>
);
