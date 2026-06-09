import React from "react";

import { Stack } from "../route-stack";
import { ApplyCohortInputActionScreen } from "../screens/apply-cohort-input-action-screen";

export const applyCohortInputActionRouteScreen = (
  <Stack.Screen
    key="ApplyCohortInputAction"
    name="ApplyCohortInputAction"
    component={ApplyCohortInputActionScreen}
  />
);
