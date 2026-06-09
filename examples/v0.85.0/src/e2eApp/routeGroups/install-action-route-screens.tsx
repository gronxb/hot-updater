import React from "react";

import { Stack } from "../route-stack";
import { InstallCurrentChannelUpdateActionScreen } from "../screens/install-current-channel-update-action-screen";
import { InstallRuntimeChannelUpdateActionScreen } from "../screens/install-runtime-channel-update-action-screen";
import { RuntimeChannelInputScreen } from "../screens/runtime-channel-input-screen";

export const installActionRouteScreens = [
  <Stack.Screen
    key="InstallCurrentChannelUpdateAction"
    name="InstallCurrentChannelUpdateAction"
    component={InstallCurrentChannelUpdateActionScreen}
  />,
  <Stack.Screen
    key="RuntimeChannelInput"
    name="RuntimeChannelInput"
    component={RuntimeChannelInputScreen}
  />,
  <Stack.Screen
    key="InstallRuntimeChannelUpdateAction"
    name="InstallRuntimeChannelUpdateAction"
    component={InstallRuntimeChannelUpdateActionScreen}
  />,
] as const;
