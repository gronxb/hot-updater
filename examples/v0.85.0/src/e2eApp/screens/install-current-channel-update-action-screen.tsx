import React from "react";

import { useE2eRuntimeModelContext } from "../runtime-model-context";
import { ActionButtonScreen } from "./action-button-screen";

export const InstallCurrentChannelUpdateActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ActionButtonScreen
      current="InstallCurrentChannelUpdateAction"
      deferPress
      onPress={() => model.installUpdate({ actionLabel: "current-channel" })}
      testID="action-install-current-channel-update"
      title="Install Current"
    />
  );
};
