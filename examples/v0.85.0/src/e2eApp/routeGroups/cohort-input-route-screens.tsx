import React from "react";

import { Stack } from "../route-stack";
import { ApplyCohortInputActionScreen } from "../screens/apply-cohort-input-action-screen";
import { CohortInputScreen } from "../screens/cohort-input-screen";

export const cohortInputRouteScreens = [
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
] as const;
