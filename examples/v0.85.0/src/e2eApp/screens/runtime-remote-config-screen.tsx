import React from "react";

import { ValueText } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const RuntimeRemoteConfigScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ValueText testID="runtime-remote-config" value={model.remoteConfigText} />
  );
};
