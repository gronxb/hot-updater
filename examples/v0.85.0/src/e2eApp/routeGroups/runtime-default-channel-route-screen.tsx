import React from "react";

import { Stack } from "../route-stack";
import { RuntimeDefaultChannelScreen } from "../screens/runtime-default-channel-screen";

export const runtimeDefaultChannelRouteScreen = (
  <Stack.Screen
    key="RuntimeDefaultChannel"
    name="RuntimeDefaultChannel"
    component={RuntimeDefaultChannelScreen}
  />
);
