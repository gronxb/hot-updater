import React from "react";

import { Stack } from "../route-stack";
import { RefreshRuntimeSnapshotActionScreen } from "../screens/refresh-runtime-snapshot-action-screen";

export const refreshRuntimeSnapshotActionRouteScreen = (
  <Stack.Screen
    key="RefreshRuntimeSnapshotAction"
    name="RefreshRuntimeSnapshotAction"
    component={RefreshRuntimeSnapshotActionScreen}
  />
);
