import React from "react";

import { InfoRow, ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const RuntimeDefaultChannelScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell current="RuntimeDefaultChannel">
      <InfoRow
        label="Default Channel"
        value={model.runtimeSnapshot.defaultChannel}
        valueTestID="runtime-default-channel"
      />
    </ScreenShell>
  );
};
