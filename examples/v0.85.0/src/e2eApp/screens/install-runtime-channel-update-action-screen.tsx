import React from "react";

import { Button, ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const InstallRuntimeChannelUpdateActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell>
      <Button
        onPress={model.installRuntimeChannelUpdate}
        testID="action-install-runtime-channel-update"
        title="Install Runtime"
      />
    </ScreenShell>
  );
};
