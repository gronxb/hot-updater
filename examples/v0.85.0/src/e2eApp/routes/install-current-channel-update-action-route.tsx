import React from "react";

import { Stack } from "../route-stack";
import { InstallCurrentChannelUpdateActionScreen } from "../screens/install-current-channel-update-action-screen";

export const installCurrentChannelUpdateActionRoute = (
  <Stack.Screen
    name="InstallCurrentChannelUpdateAction"
    component={InstallCurrentChannelUpdateActionScreen}
  />
);
