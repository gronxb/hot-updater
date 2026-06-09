import React from "react";

import { Stack } from "../route-stack";
import { SetCohortQaActionScreen } from "../screens/set-cohort-qa-action-screen";

export const setCohortQaActionRouteScreen = (
  <Stack.Screen
    key="SetCohortQaAction"
    name="SetCohortQaAction"
    component={SetCohortQaActionScreen}
  />
);
