import React from "react";

import { Stack } from "../route-stack";
import { RuntimeBundleScreen } from "../screens/runtime-bundle-screen";
import { RuntimeLargeAssetScreen } from "../screens/runtime-large-asset-screen";
import { RuntimeMarkerScreen } from "../screens/runtime-marker-screen";

export const runtimeBundleAssertionRouteScreens = [
  <Stack.Screen
    key="RuntimeBundle"
    name="RuntimeBundle"
    component={RuntimeBundleScreen}
  />,
  <Stack.Screen
    key="RuntimeMarker"
    name="RuntimeMarker"
    component={RuntimeMarkerScreen}
  />,
  <Stack.Screen
    key="RuntimeLargeAsset"
    name="RuntimeLargeAsset"
    component={RuntimeLargeAssetScreen}
  />,
] as const;
