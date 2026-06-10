import React from "react";

import { Stack } from "../route-stack";
import { RuntimeInitialCohortScreen } from "../screens/runtime-initial-cohort-screen";

export const runtimeInitialCohortRoute = (
  <Stack.Screen
    name="RuntimeInitialCohort"
    component={RuntimeInitialCohortScreen}
  />
);
