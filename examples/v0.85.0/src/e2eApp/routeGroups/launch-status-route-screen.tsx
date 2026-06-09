import React from "react";

import { Stack } from "../route-stack";
import { LaunchStatusScreen } from "../screens/launch-status-screen";

export const launchStatusRouteScreen = (
  <Stack.Screen
    key="LaunchStatus"
    name="LaunchStatus"
    component={LaunchStatusScreen}
  />
);
