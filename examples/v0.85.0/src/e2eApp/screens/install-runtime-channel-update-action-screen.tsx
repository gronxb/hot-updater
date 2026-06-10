import React from "react";

import { PressInActionButton, ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const InstallRuntimeChannelUpdateActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell>
      <PressInActionButton
        onPress={model.installRuntimeChannelUpdate}
        testID="action-install-runtime-channel-update"
        title="Install Runtime"
      />
    </ScreenShell>
  );
};
