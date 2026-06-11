import React from "react";

import { Stack } from "../route-stack";
import { RefreshRuntimeSnapshotActionScreen } from "../screens/refresh-runtime-snapshot-action-screen";

export const refreshRuntimeSnapshotActionRoute = (
  <Stack.Screen
    name="RefreshRuntimeSnapshotAction"
    component={RefreshRuntimeSnapshotActionScreen}
  />
);
