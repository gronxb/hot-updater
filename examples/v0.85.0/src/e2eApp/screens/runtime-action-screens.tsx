import React from "react";

import { ActionButtonScreen } from "./action-button-screen";
import type { ScreenProps } from "./types";

export const RefreshRuntimeSnapshotActionScreen = ({ model }: ScreenProps) => (
  <ActionButtonScreen
    current="RefreshRuntimeSnapshotAction"
    onPress={model.refreshRuntimeSnapshot}
    testID="action-refresh-runtime-snapshot"
    title="Refresh"
  />
);

export const ReloadAppActionScreen = ({ model }: ScreenProps) => (
  <ActionButtonScreen
    current="ReloadAppAction"
    onPress={model.reloadApp}
    testID="action-reload-app"
    title="Reload"
  />
);

export const ResetRuntimeChannelActionScreen = ({ model }: ScreenProps) => (
  <ActionButtonScreen
    current="ResetRuntimeChannelAction"
    onPress={model.resetRuntimeChannel}
    testID="action-reset-runtime-channel"
    title="Reset Channel"
  />
);
