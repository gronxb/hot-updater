import React from "react";

import { PressInActionButton, ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const ResetRuntimeChannelActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell>
      <PressInActionButton
        onPress={model.resetRuntimeChannel}
        testID="action-reset-runtime-channel"
        title="Reset Channel"
      />
    </ScreenShell>
  );
};
