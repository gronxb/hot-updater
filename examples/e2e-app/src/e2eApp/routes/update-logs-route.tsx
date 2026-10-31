import React from "react";

import { Stack } from "../route-stack";
import { UpdateLogsScreen } from "../screens/update-logs-screen";

export const updateLogsRoute = (
  <Stack.Screen name="UpdateLogs" component={UpdateLogsScreen} />
);
