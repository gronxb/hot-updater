import React from "react";

import { Stack } from "../route-stack";
import { RestoreInitialCohortActionScreen } from "../screens/restore-initial-cohort-action-screen";

export const restoreInitialCohortActionRoute = (
  <Stack.Screen
    name="RestoreInitialCohortAction"
    component={RestoreInitialCohortActionScreen}
  />
);
