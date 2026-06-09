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

export const runtimeAssertionRouteScreens = [
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
  <Stack.Screen
    key="RuntimeCurrentChannel"
    name="RuntimeCurrentChannel"
    component={RuntimeCurrentChannelScreen}
  />,
  <Stack.Screen
    key="RuntimeDefaultChannel"
    name="RuntimeDefaultChannel"
    component={RuntimeDefaultChannelScreen}
  />,
  <Stack.Screen
    key="RuntimeChannelSwitched"
    name="RuntimeChannelSwitched"
    component={RuntimeChannelSwitchedScreen}
  />,
  <Stack.Screen
    key="RuntimeCurrentCohort"
    name="RuntimeCurrentCohort"
    component={RuntimeCurrentCohortScreen}
  />,
  <Stack.Screen
    key="RuntimeInitialCohort"
    name="RuntimeInitialCohort"
    component={RuntimeInitialCohortScreen}
  />,
] as const;
