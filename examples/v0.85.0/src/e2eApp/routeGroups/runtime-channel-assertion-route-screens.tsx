import React from "react";

import { Stack } from "../route-stack";
import { RuntimeChannelSwitchedScreen } from "../screens/runtime-channel-switched-screen";
import { RuntimeCurrentChannelScreen } from "../screens/runtime-current-channel-screen";
import { RuntimeDefaultChannelScreen } from "../screens/runtime-default-channel-screen";

export const runtimeChannelAssertionRouteScreens = [
  <Stack.Screen
    key="RuntimeCurrentChannel"
    name="RuntimeCurrentChannel"
    component={RuntimeCurrentChannelScreen}
  />,
  <Stack.Screen
    key="RuntimeDefaultChannel"
    name="RuntimeDefaultChannel"
    component={RuntimeDefaultChannelScreen}
  />,
  <Stack.Screen
    key="RuntimeChannelSwitched"
    name="RuntimeChannelSwitched"
    component={RuntimeChannelSwitchedScreen}
  />,
] as const;
