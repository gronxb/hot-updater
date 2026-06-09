import React from "react";

import { useE2eRuntimeModelContext } from "../runtime-model-context";
import { ActionButtonScreen } from "./action-button-screen";

export const ResetRuntimeChannelActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ActionButtonScreen
      current="ResetRuntimeChannelAction"
      onPress={model.resetRuntimeChannel}
      testID="action-reset-runtime-channel"
      title="Reset Channel"
    />
  );
};
