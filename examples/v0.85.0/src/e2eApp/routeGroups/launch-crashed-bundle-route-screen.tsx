import React from "react";

import { Stack } from "../route-stack";
import { LaunchCrashedBundleScreen } from "../screens/launch-crashed-bundle-screen";

export const launchCrashedBundleRouteScreen = (
  <Stack.Screen
    key="LaunchCrashedBundle"
    name="LaunchCrashedBundle"
    component={LaunchCrashedBundleScreen}
  />
);
