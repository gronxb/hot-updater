import React from "react";

import { ScreenShell, ValueText } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const RuntimeCurrentChannelScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell>
      <ValueText
        testID="runtime-current-channel"
        value={model.runtimeSnapshot.channel}
      />
    </ScreenShell>
  );
};
