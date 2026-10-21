import React from "react";

import { ValueText } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const LaunchTransitionScreen = () => {
  const model = useE2eRuntimeModelContext();
  return (
    <ValueText
      testID="launch-transition-result"
      value={model.launchTransitionText}
    />
  );
};
