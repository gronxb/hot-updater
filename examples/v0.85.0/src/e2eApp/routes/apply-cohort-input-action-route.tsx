import React from "react";

import { Stack } from "../route-stack";
import { ApplyCohortInputActionScreen } from "../screens/apply-cohort-input-action-screen";

export const applyCohortInputActionRoute = (
  <Stack.Screen
    name="ApplyCohortInputAction"
    component={ApplyCohortInputActionScreen}
  />
);
