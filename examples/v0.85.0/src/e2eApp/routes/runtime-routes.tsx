import React from "react";

import { Stack } from "../route-stack";
import { RuntimeBundleScreen } from "../screens/runtime-bundle-screen";
import { RuntimeChannelSwitchedScreen } from "../screens/runtime-channel-switched-screen";
import { RuntimeCurrentChannelScreen } from "../screens/runtime-current-channel-screen";
import { RuntimeCurrentCohortScreen } from "../screens/runtime-current-cohort-screen";
import { RuntimeDefaultChannelScreen } from "../screens/runtime-default-channel-screen";
import { RuntimeInitialCohortScreen } from "../screens/runtime-initial-cohort-screen";
import { RuntimeLargeAssetScreen } from "../screens/runtime-large-asset-screen";
import { RuntimeMarkerScreen } from "../screens/runtime-marker-screen";

export const runtimeRoutes = (
  <>
    <Stack.Screen name="RuntimeBundle" component={RuntimeBundleScreen} />
    <Stack.Screen
      name="RuntimeChannelSwitched"
      component={RuntimeChannelSwitchedScreen}
    />
    <Stack.Screen
      name="RuntimeCurrentChannel"
      component={RuntimeCurrentChannelScreen}
    />
    <Stack.Screen
      name="RuntimeCurrentCohort"
      component={RuntimeCurrentCohortScreen}
    />
    <Stack.Screen
      name="RuntimeDefaultChannel"
      component={RuntimeDefaultChannelScreen}
    />
    <Stack.Screen
      name="RuntimeInitialCohort"
      component={RuntimeInitialCohortScreen}
    />
    <Stack.Screen
      name="RuntimeLargeAsset"
      component={RuntimeLargeAssetScreen}
    />
    <Stack.Screen name="RuntimeMarker" component={RuntimeMarkerScreen} />
  </>
);
