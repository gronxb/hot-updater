import React from "react";

import { InfoRow, ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const RuntimeChannelSwitchedScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell>
      <InfoRow
        label="Channel Switched"
        value={String(model.runtimeSnapshot.isChannelSwitched)}
        valueTestID="runtime-channel-switched"
      />
    </ScreenShell>
  );
};
