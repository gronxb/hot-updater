import React from "react";

import { FocusedActionRoute } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const FetchRemoteConfigActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <FocusedActionRoute
      onFocus={model.fetchRemoteConfig}
      testID="action-fetch-remote-config"
      title="Fetch Remote Config"
    />
  );
};
