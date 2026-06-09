import React from "react";

import { Stack } from "../route-stack";
import { RuntimeBundleScreen } from "../screens/runtime-bundle-screen";
import { RuntimeChannelSummaryScreen } from "../screens/runtime-channel-summary-screen";
import { RuntimeCohortSummaryScreen } from "../screens/runtime-cohort-summary-screen";
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
    key="RuntimeChannelSummary"
    name="RuntimeChannelSummary"
    component={RuntimeChannelSummaryScreen}
  />,
  <Stack.Screen
    key="RuntimeCohortSummary"
    name="RuntimeCohortSummary"
    component={RuntimeCohortSummaryScreen}
  />,
] as const;
