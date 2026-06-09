import React from "react";

import { Stack } from "../route-stack";
import { InstallCurrentChannelUpdateActionScreen } from "../screens/install-current-channel-update-action-screen";
import { InstallRuntimeChannelUpdateActionScreen } from "../screens/install-runtime-channel-update-action-screen";

export const installActionRoutes = (
  <>
    <Stack.Screen
      name="InstallCurrentChannelUpdateAction"
      component={InstallCurrentChannelUpdateActionScreen}
    />
    <Stack.Screen
      name="InstallRuntimeChannelUpdateAction"
      component={InstallRuntimeChannelUpdateActionScreen}
    />
  </>
);
