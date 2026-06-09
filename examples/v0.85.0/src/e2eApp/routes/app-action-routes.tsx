import React from "react";

import { Stack } from "../route-stack";
import { ClearCrashHistoryActionScreen } from "../screens/clear-crash-history-action-screen";
import { ReloadAppActionScreen } from "../screens/reload-app-action-screen";

export const appActionRoutes = (
  <>
    <Stack.Screen
      name="ClearCrashHistoryAction"
      component={ClearCrashHistoryActionScreen}
    />
    <Stack.Screen name="ReloadAppAction" component={ReloadAppActionScreen} />
  </>
);
