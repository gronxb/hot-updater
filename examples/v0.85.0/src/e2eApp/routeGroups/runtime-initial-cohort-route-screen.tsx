import React from "react";

import { Stack } from "../route-stack";
import { RuntimeInitialCohortScreen } from "../screens/runtime-initial-cohort-screen";

export const runtimeInitialCohortRouteScreen = (
  <Stack.Screen
    key="RuntimeInitialCohort"
    name="RuntimeInitialCohort"
    component={RuntimeInitialCohortScreen}
  />
);
