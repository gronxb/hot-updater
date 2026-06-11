import React from "react";

import { Stack } from "../route-stack";
import { RuntimeChannelSwitchedScreen } from "../screens/runtime-channel-switched-screen";

export const runtimeChannelSwitchedRoute = (
  <Stack.Screen
    name="RuntimeChannelSwitched"
    component={RuntimeChannelSwitchedScreen}
  />
);
