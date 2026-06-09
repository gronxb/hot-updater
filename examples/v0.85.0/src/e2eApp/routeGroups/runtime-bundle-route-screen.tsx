import React from "react";

import { Stack } from "../route-stack";
import { RuntimeBundleScreen } from "../screens/runtime-bundle-screen";

export const runtimeBundleRouteScreen = (
  <Stack.Screen
    key="RuntimeBundle"
    name="RuntimeBundle"
    component={RuntimeBundleScreen}
  />
);
