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
