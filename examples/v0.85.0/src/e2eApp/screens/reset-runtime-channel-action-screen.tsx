import React from "react";

import { FocusedActionRoute, ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const ResetRuntimeChannelActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell>
      <FocusedActionRoute
        onFocus={model.resetRuntimeChannel}
        testID="action-reset-runtime-channel"
        title="Reset Channel"
      />
    </ScreenShell>
  );
};
