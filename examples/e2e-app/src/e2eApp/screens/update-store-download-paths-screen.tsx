import React from "react";

import { ValueText } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const UpdateStoreDownloadPathsScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ValueText
      testID="update-store-download-paths"
      value={model.updateStoreDownloadPathsText}
    />
  );
};
