import React from "react";

import { Stack } from "../route-stack";
import { RuntimeDefaultChannelScreen } from "../screens/runtime-default-channel-screen";

export const runtimeDefaultChannelRoute = (
  <Stack.Screen
    name="RuntimeDefaultChannel"
    component={RuntimeDefaultChannelScreen}
  />
);
