import React from "react";

import { InfoRow, ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const UpdateStoreDownloadPathsScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell current="UpdateStoreDownloadPaths">
      <InfoRow
        label="Download Paths"
        value={model.updateStoreDownloadPathsText}
        valueTestID="update-store-download-paths"
      />
    </ScreenShell>
  );
};
