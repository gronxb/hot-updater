import React from "react";

import { InfoRow, ScreenShell } from "../components";
import type { ScreenProps } from "./types";

export const RuntimeBundleScreen = ({ model }: ScreenProps) => (
  <ScreenShell current="RuntimeBundle">
    <InfoRow
      label="Bundle ID"
      value={model.runtimeSnapshot.bundleId}
      valueTestID="runtime-bundle-id"
    />
  </ScreenShell>
);
