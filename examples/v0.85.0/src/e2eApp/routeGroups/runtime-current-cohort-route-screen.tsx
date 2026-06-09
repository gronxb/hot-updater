import React from "react";

import { Stack } from "../route-stack";
import { RuntimeCurrentCohortScreen } from "../screens/runtime-current-cohort-screen";

export const runtimeCurrentCohortRouteScreen = (
  <Stack.Screen
    key="RuntimeCurrentCohort"
    name="RuntimeCurrentCohort"
    component={RuntimeCurrentCohortScreen}
  />
);
