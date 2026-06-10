import React from "react";

import { Stack } from "../route-stack";
import { InstallRuntimeChannelUpdateActionScreen } from "../screens/install-runtime-channel-update-action-screen";

export const installRuntimeChannelUpdateActionRoute = (
  <Stack.Screen
    name="InstallRuntimeChannelUpdateAction"
    component={InstallRuntimeChannelUpdateActionScreen}
  />
);
