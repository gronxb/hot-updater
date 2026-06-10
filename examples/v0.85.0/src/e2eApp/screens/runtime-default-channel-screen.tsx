import React from "react";

import { ValueText } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const RuntimeDefaultChannelScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ValueText
      testID="runtime-default-channel"
      value={model.runtimeSnapshot.defaultChannel}
    />
  );
};
