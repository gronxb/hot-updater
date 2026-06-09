import React from "react";

import { ActionButtonWithStartCount, ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const InstallCurrentChannelUpdateActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell>
      <ActionButtonWithStartCount
        onPress={() => model.installUpdate({ actionLabel: "current-channel" })}
        testID="action-install-current-channel-update"
        title="Install Current"
      />
    </ScreenShell>
  );
};
