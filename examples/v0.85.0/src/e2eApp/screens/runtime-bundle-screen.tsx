import React from "react";

import { InfoRow, ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const RuntimeBundleScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell current="RuntimeBundle">
      <InfoRow
        label="Bundle ID"
        value={model.runtimeSnapshot.bundleId}
        valueTestID="runtime-bundle-id"
      />
    </ScreenShell>
  );
};
