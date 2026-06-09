import React from "react";

import { InfoRow, ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const UpdateStoreDownloadedScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell>
      <InfoRow
        label="Downloaded"
        value={String(model.isUpdateDownloaded)}
        valueTestID="update-store-downloaded"
      />
    </ScreenShell>
  );
};
