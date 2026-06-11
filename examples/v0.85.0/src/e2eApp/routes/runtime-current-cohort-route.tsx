import React from "react";

import { Stack } from "../route-stack";
import { RuntimeCurrentCohortScreen } from "../screens/runtime-current-cohort-screen";

export const runtimeCurrentCohortRoute = (
  <Stack.Screen
    name="RuntimeCurrentCohort"
    component={RuntimeCurrentCohortScreen}
  />
);
