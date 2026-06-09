import React from "react";

import { Stack } from "../route-stack";
import { RuntimeChannelSwitchedScreen } from "../screens/runtime-channel-switched-screen";
import { RuntimeCurrentChannelScreen } from "../screens/runtime-current-channel-screen";
import { RuntimeDefaultChannelScreen } from "../screens/runtime-default-channel-screen";

export const runtimeChannelRoutes = (
  <>
    <Stack.Screen
      name="RuntimeChannelSwitched"
      component={RuntimeChannelSwitchedScreen}
    />
    <Stack.Screen
      name="RuntimeCurrentChannel"
      component={RuntimeCurrentChannelScreen}
    />
    <Stack.Screen
      name="RuntimeDefaultChannel"
      component={RuntimeDefaultChannelScreen}
    />
  </>
);
