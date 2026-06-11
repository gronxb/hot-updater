import React from "react";

import { ValueText } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const RuntimeCurrentChannelScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ValueText
      testID="runtime-current-channel"
      value={model.runtimeSnapshot.channel}
    />
  );
};
