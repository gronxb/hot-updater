import React from "react";

import { Stack } from "../route-stack";
import { CrashHistoryCountScreen } from "../screens/crash-history-count-screen";

export const crashHistoryCountRouteScreen = (
  <Stack.Screen
    key="CrashHistoryCount"
    name="CrashHistoryCount"
    component={CrashHistoryCountScreen}
  />
);
