import React from "react";

import { Stack } from "../route-stack";
import { RuntimeChannelInputScreen } from "../screens/runtime-channel-input-screen";

export const runtimeChannelInputRouteScreen = (
  <Stack.Screen
    key="RuntimeChannelInput"
    name="RuntimeChannelInput"
    component={RuntimeChannelInputScreen}
  />
);
