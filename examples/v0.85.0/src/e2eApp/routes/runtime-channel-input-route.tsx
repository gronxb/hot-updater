import React from "react";

import { Stack } from "../route-stack";
import { RuntimeChannelInputScreen } from "../screens/runtime-channel-input-screen";

export const runtimeChannelInputRoute = (
  <Stack.Screen
    name="RuntimeChannelInput"
    component={RuntimeChannelInputScreen}
  />
);
