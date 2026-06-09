import React from "react";

import { Stack } from "../route-stack";
import { RefreshRuntimeSnapshotActionScreen } from "../screens/refresh-runtime-snapshot-action-screen";
import { ResetRuntimeChannelActionScreen } from "../screens/reset-runtime-channel-action-screen";

export const runtimeActionRoutes = (
  <>
    <Stack.Screen
      name="RefreshRuntimeSnapshotAction"
      component={RefreshRuntimeSnapshotActionScreen}
    />
    <Stack.Screen
      name="ResetRuntimeChannelAction"
      component={ResetRuntimeChannelActionScreen}
    />
  </>
);
