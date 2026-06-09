import React from "react";

import { InfoRow, ScreenShell } from "../components";
import type { ScreenProps } from "./types";

export const RuntimeMarkerScreen = ({ model }: ScreenProps) => (
  <ScreenShell current="RuntimeMarker">
    <InfoRow
      label="Marker"
      value={model.scenarioMarker}
      valueTestID="runtime-scenario-marker"
    />
  </ScreenShell>
);
