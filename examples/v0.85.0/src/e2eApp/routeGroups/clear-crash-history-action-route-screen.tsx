import React from "react";

import { Stack } from "../route-stack";
import { ClearCrashHistoryActionScreen } from "../screens/clear-crash-history-action-screen";

export const clearCrashHistoryActionRouteScreen = (
  <Stack.Screen
    key="ClearCrashHistoryAction"
    name="ClearCrashHistoryAction"
    component={ClearCrashHistoryActionScreen}
  />
);
