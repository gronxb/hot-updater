import React from "react";

import { Stack } from "../route-stack";
import { RuntimeChannelSwitchedScreen } from "../screens/runtime-channel-switched-screen";

export const runtimeChannelSwitchedRouteScreen = (
  <Stack.Screen
    key="RuntimeChannelSwitched"
    name="RuntimeChannelSwitched"
    component={RuntimeChannelSwitchedScreen}
  />
);
