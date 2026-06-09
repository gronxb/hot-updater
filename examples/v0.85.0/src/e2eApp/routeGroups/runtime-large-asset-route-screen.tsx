import React from "react";

import { Stack } from "../route-stack";
import { RuntimeLargeAssetScreen } from "../screens/runtime-large-asset-screen";

export const runtimeLargeAssetRouteScreen = (
  <Stack.Screen
    key="RuntimeLargeAsset"
    name="RuntimeLargeAsset"
    component={RuntimeLargeAssetScreen}
  />
);
