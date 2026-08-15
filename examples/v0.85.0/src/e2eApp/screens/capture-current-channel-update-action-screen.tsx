import React from "react";

import { FocusedActionRoute } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const CaptureCurrentChannelUpdateActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <FocusedActionRoute
      onFocus={model.captureCurrentChannelUpdate}
      testID="action-capture-current-channel-update"
      title="Capture Current"
    />
  );
};
