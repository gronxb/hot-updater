import React from "react";

import { FocusedActionRoute } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const ResetRuntimeChannelActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <FocusedActionRoute
      onFocus={model.resetRuntimeChannel}
      testID="action-reset-runtime-channel"
      title="Reset Channel"
    />
  );
};
