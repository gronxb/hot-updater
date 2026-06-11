import React from "react";

import { Stack } from "../route-stack";
import { RuntimeCurrentChannelScreen } from "../screens/runtime-current-channel-screen";

export const runtimeCurrentChannelRoute = (
  <Stack.Screen
    name="RuntimeCurrentChannel"
    component={RuntimeCurrentChannelScreen}
  />
);
