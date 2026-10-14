import React from "react";

import { Stack } from "../route-stack";
import { ApplyCapturedUpdateInBackgroundActionScreen } from "../screens/apply-captured-update-in-background-action-screen";

export const applyCapturedUpdateInBackgroundActionRoute = (
  <Stack.Screen
    name="ApplyCapturedUpdateInBackgroundAction"
    component={ApplyCapturedUpdateInBackgroundActionScreen}
  />
);
