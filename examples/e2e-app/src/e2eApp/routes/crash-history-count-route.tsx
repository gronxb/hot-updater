import React from "react";

import { Stack } from "../route-stack";
import { CrashHistoryCountScreen } from "../screens/crash-history-count-screen";

export const crashHistoryCountRoute = (
  <Stack.Screen name="CrashHistoryCount" component={CrashHistoryCountScreen} />
);
