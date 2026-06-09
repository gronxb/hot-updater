import React from "react";

import { ActionButtonWithStartCount, ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const ResetRuntimeChannelActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell>
      <ActionButtonWithStartCount
        onPress={model.resetRuntimeChannel}
        testID="action-reset-runtime-channel"
        title="Reset Channel"
      />
    </ScreenShell>
  );
};
