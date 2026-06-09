import React from "react";

import { Stack } from "../route-stack";
import { RuntimeBundleScreen } from "../screens/runtime-bundle-screen";
import { RuntimeLargeAssetScreen } from "../screens/runtime-large-asset-screen";
import { RuntimeMarkerScreen } from "../screens/runtime-marker-screen";

export const runtimeBundleRoutes = (
  <>
    <Stack.Screen name="RuntimeBundle" component={RuntimeBundleScreen} />
    <Stack.Screen
      name="RuntimeLargeAsset"
      component={RuntimeLargeAssetScreen}
    />
    <Stack.Screen name="RuntimeMarker" component={RuntimeMarkerScreen} />
  </>
);
