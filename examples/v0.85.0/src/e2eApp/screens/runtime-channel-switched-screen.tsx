import React from "react";

import { ScreenShell, ValueText } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const RuntimeChannelSwitchedScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell>
      <ValueText
        testID="runtime-channel-switched"
        value={String(model.runtimeSnapshot.isChannelSwitched)}
      />
    </ScreenShell>
  );
};
