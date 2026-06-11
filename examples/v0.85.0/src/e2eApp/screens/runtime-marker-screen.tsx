import React from "react";

import { ValueText } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const RuntimeMarkerScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ValueText testID="runtime-scenario-marker" value={model.scenarioMarker} />
  );
};
