import React from "react";

import { Stack } from "../route-stack";
import { ClearUpdateLogsActionScreen } from "../screens/clear-update-logs-action-screen";

export const clearUpdateLogsActionRoute = (
  <Stack.Screen
    name="ClearUpdateLogsAction"
    component={ClearUpdateLogsActionScreen}
  />
);
