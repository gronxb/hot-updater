import React from "react";

import { Stack } from "../route-stack";
import { RuntimeCurrentChannelScreen } from "../screens/runtime-current-channel-screen";

export const runtimeCurrentChannelRouteScreen = (
  <Stack.Screen
    key="RuntimeCurrentChannel"
    name="RuntimeCurrentChannel"
    component={RuntimeCurrentChannelScreen}
  />
);
