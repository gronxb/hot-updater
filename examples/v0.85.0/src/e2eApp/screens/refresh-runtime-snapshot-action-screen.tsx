import React from "react";

import { useE2eRuntimeModelContext } from "../runtime-model-context";
import { ActionButtonScreen } from "./action-button-screen";

export const RefreshRuntimeSnapshotActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ActionButtonScreen
      current="RefreshRuntimeSnapshotAction"
      onPress={model.refreshRuntimeSnapshot}
      testID="action-refresh-runtime-snapshot"
      title="Refresh"
    />
  );
};
