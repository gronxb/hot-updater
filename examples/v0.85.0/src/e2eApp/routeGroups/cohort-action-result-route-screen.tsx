import React from "react";

import { Stack } from "../route-stack";
import { CohortActionResultScreen } from "../screens/cohort-action-result-screen";

export const cohortActionResultRouteScreen = (
  <Stack.Screen
    key="CohortActionResult"
    name="CohortActionResult"
    component={CohortActionResultScreen}
  />
);
