import React from "react";

import { InfoRow, ScreenShell, Section } from "../components";
import type { ScreenProps } from "./types";

export const RuntimeMarkerScreen = ({ model }: ScreenProps) => (
  <ScreenShell current="RuntimeMarker">
    <Section title="Runtime Marker">
      <InfoRow
        label="Marker"
        value={model.scenarioMarker}
        valueTestID="runtime-scenario-marker"
      />
    </Section>
  </ScreenShell>
);
