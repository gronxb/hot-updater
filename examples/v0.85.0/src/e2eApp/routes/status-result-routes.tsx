import React from "react";

import { Stack } from "../route-stack";
import { ChannelActionResultScreen } from "../screens/channel-action-result-screen";
import { CohortActionResultScreen } from "../screens/cohort-action-result-screen";
import { CrashHistoryCountScreen } from "../screens/crash-history-count-screen";
import { UpdateActionResultScreen } from "../screens/update-action-result-screen";

export const statusResultRoutes = (
  <>
    <Stack.Screen
      name="ChannelActionResult"
      component={ChannelActionResultScreen}
    />
    <Stack.Screen
      name="CohortActionResult"
      component={CohortActionResultScreen}
    />
    <Stack.Screen
      name="CrashHistoryCount"
      component={CrashHistoryCountScreen}
    />
    <Stack.Screen
      name="UpdateActionResult"
      component={UpdateActionResultScreen}
    />
  </>
);
