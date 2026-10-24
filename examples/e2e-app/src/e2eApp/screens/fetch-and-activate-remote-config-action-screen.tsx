import React from "react";

import { FocusedActionRoute } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const FetchAndActivateRemoteConfigActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <FocusedActionRoute
      onFocus={model.fetchAndActivateRemoteConfig}
      testID="action-fetch-and-activate-remote-config"
      title="Fetch and Activate Remote Config"
    />
  );
};
