import React from "react";

import { ScreenShell, ValueText } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const RuntimeDefaultChannelScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell>
      <ValueText
        testID="runtime-default-channel"
        value={model.runtimeSnapshot.defaultChannel}
      />
    </ScreenShell>
  );
};
