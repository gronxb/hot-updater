import React from "react";

import { ScreenShell, ValueText } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const RuntimeMarkerScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell>
      <ValueText
        testID="runtime-scenario-marker"
        value={model.scenarioMarker}
      />
    </ScreenShell>
  );
};
