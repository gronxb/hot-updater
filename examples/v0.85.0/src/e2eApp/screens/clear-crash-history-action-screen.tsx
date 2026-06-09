import React from "react";

import { useE2eRuntimeModelContext } from "../runtime-model-context";
import { ActionButtonScreen } from "./action-button-screen";

export const ClearCrashHistoryActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ActionButtonScreen
      current="ClearCrashHistoryAction"
      onPress={model.clearCrashHistory}
      testID="action-clear-crash-history"
      title="Clear Crashes"
    />
  );
};
