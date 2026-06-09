import React from "react";

import { Stack } from "../route-stack";
import { RuntimeCurrentCohortScreen } from "../screens/runtime-current-cohort-screen";
import { RuntimeInitialCohortScreen } from "../screens/runtime-initial-cohort-screen";

export const runtimeCohortAssertionRouteScreens = [
  <Stack.Screen
    key="RuntimeCurrentCohort"
    name="RuntimeCurrentCohort"
    component={RuntimeCurrentCohortScreen}
  />,
  <Stack.Screen
    key="RuntimeInitialCohort"
    name="RuntimeInitialCohort"
    component={RuntimeInitialCohortScreen}
  />,
] as const;
