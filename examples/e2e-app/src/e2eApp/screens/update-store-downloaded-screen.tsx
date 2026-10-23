import React from "react";

import { ValueText } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const UpdateStoreDownloadedScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ValueText
      testID="update-store-downloaded"
      value={String(model.isUpdateDownloaded)}
    />
  );
};
