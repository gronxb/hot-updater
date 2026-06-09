import React from "react";

import { useE2eRuntimeModelContext } from "../runtime-model-context";
import { ActionButtonScreen } from "./action-button-screen";

export const InstallRuntimeChannelUpdateActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ActionButtonScreen
      current="InstallRuntimeChannelUpdateAction"
      deferPress
      onPress={model.installRuntimeChannelUpdate}
      testID="action-install-runtime-channel-update"
      title="Install Runtime"
    />
  );
};
