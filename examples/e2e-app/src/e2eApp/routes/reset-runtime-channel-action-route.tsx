import React from "react";

import { Stack } from "../route-stack";
import { ResetRuntimeChannelActionScreen } from "../screens/reset-runtime-channel-action-screen";

export const resetRuntimeChannelActionRoute = (
  <Stack.Screen
    name="ResetRuntimeChannelAction"
    component={ResetRuntimeChannelActionScreen}
  />
);
