import React from "react";

import { ValueText } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const RuntimeReportedBundleScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ValueText
      testID="runtime-reported-bundle-id"
      value={model.runtimeSnapshot.reportedBundleId}
    />
  );
};
