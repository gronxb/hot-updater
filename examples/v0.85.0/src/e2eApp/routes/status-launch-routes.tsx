import React from "react";

import { Stack } from "../route-stack";
import { LaunchCrashedBundleScreen } from "../screens/launch-crashed-bundle-screen";
import { LaunchStatusScreen } from "../screens/launch-status-screen";

export const statusLaunchRoutes = (
  <>
    <Stack.Screen
      name="LaunchCrashedBundle"
      component={LaunchCrashedBundleScreen}
    />
    <Stack.Screen name="LaunchStatus" component={LaunchStatusScreen} />
  </>
);
