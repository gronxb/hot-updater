import React from "react";

import { Stack } from "../route-stack";
import { ResetRuntimeChannelActionScreen } from "../screens/reset-runtime-channel-action-screen";

export const resetRuntimeChannelActionRouteScreen = (
  <Stack.Screen
    key="ResetRuntimeChannelAction"
    name="ResetRuntimeChannelAction"
    component={ResetRuntimeChannelActionScreen}
  />
);
