import React from "react";

import { Stack } from "../route-stack";
import { LaunchCrashedBundleScreen } from "../screens/launch-crashed-bundle-screen";

export const launchCrashedBundleRoute = (
  <Stack.Screen
    name="LaunchCrashedBundle"
    component={LaunchCrashedBundleScreen}
  />
);
