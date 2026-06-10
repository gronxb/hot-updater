import React from "react";

import { FocusedActionRoute, ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const InstallCurrentChannelUpdateActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell>
      <FocusedActionRoute
        onFocus={() => model.installUpdate({ actionLabel: "current-channel" })}
        testID="action-install-current-channel-update"
        title="Install Current"
      />
    </ScreenShell>
  );
};
