import React from "react";

import { Stack } from "../route-stack";
import { CohortActionResultScreen } from "../screens/cohort-action-result-screen";

export const cohortActionResultRoute = (
  <Stack.Screen
    name="CohortActionResult"
    component={CohortActionResultScreen}
  />
);
