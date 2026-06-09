import React from "react";

import { Stack } from "../route-stack";
import { RestoreInitialCohortActionScreen } from "../screens/restore-initial-cohort-action-screen";

export const restoreInitialCohortActionRouteScreen = (
  <Stack.Screen
    key="RestoreInitialCohortAction"
    name="RestoreInitialCohortAction"
    component={RestoreInitialCohortActionScreen}
  />
);
