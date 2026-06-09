import React from "react";

import { InfoRow, ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const RuntimeMarkerScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell current="RuntimeMarker">
      <InfoRow
        label="Marker"
        value={model.scenarioMarker}
        valueTestID="runtime-scenario-marker"
      />
    </ScreenShell>
  );
};
