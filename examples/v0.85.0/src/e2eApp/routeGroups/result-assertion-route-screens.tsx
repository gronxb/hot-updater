import React from "react";

import { Stack } from "../route-stack";
import { ChannelActionResultScreen } from "../screens/channel-action-result-screen";
import { CohortActionResultScreen } from "../screens/cohort-action-result-screen";
import { UpdateActionResultScreen } from "../screens/update-action-result-screen";

export const resultAssertionRouteScreens = [
  <Stack.Screen
    key="ChannelActionResult"
    name="ChannelActionResult"
    component={ChannelActionResultScreen}
  />,
  <Stack.Screen
    key="UpdateActionResult"
    name="UpdateActionResult"
    component={UpdateActionResultScreen}
  />,
  <Stack.Screen
    key="CohortActionResult"
    name="CohortActionResult"
    component={CohortActionResultScreen}
  />,
] as const;
