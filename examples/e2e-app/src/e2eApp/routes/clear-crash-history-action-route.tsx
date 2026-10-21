import React from "react";

import { Stack } from "../route-stack";
import { ClearCrashHistoryActionScreen } from "../screens/clear-crash-history-action-screen";

export const clearCrashHistoryActionRoute = (
  <Stack.Screen
    name="ClearCrashHistoryAction"
    component={ClearCrashHistoryActionScreen}
  />
);
