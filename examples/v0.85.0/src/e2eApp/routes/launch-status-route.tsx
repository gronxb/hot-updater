import React from "react";

import { Stack } from "../route-stack";
import { LaunchStatusScreen } from "../screens/launch-status-screen";

export const launchStatusRoute = (
  <Stack.Screen name="LaunchStatus" component={LaunchStatusScreen} />
);
