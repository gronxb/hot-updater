import React from "react";

import { ScreenShell, ValueText } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const UpdateStoreDownloadedScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell>
      <ValueText
        testID="update-store-downloaded"
        value={String(model.isUpdateDownloaded)}
      />
    </ScreenShell>
  );
};
