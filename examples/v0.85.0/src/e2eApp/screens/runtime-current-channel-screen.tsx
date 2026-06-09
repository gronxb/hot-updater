import React from "react";

import { InfoRow, ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const RuntimeCurrentChannelScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell current="RuntimeCurrentChannel">
      <InfoRow
        label="Current Channel"
        value={model.runtimeSnapshot.channel}
        valueTestID="runtime-current-channel"
      />
    </ScreenShell>
  );
};
