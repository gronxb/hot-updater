import React from "react";

import { FocusedActionRoute } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const ActivateRemoteConfigActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <FocusedActionRoute
      onFocus={model.activateRemoteConfig}
      testID="action-activate-remote-config"
      title="Activate Remote Config"
    />
  );
};
