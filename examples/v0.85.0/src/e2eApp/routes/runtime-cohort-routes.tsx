import React from "react";

import { Stack } from "../route-stack";
import { RuntimeCurrentCohortScreen } from "../screens/runtime-current-cohort-screen";
import { RuntimeInitialCohortScreen } from "../screens/runtime-initial-cohort-screen";

export const runtimeCohortRoutes = (
  <>
    <Stack.Screen
      name="RuntimeCurrentCohort"
      component={RuntimeCurrentCohortScreen}
    />
    <Stack.Screen
      name="RuntimeInitialCohort"
      component={RuntimeInitialCohortScreen}
    />
  </>
);
