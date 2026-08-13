import React from "react";

import { Stack } from "../route-stack";
import { ApplyCapturedUpdateActionScreen } from "../screens/apply-captured-update-action-screen";

export const applyCapturedUpdateActionRoute = (
  <Stack.Screen
    name="ApplyCapturedUpdateAction"
    component={ApplyCapturedUpdateActionScreen}
  />
);
