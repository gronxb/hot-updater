import React from "react";

import { Stack } from "../route-stack";
import { CohortInputScreen } from "../screens/cohort-input-screen";

export const cohortInputRouteScreen = (
  <Stack.Screen
    key="CohortInput"
    name="CohortInput"
    component={CohortInputScreen}
  />
);
