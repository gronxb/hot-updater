import React from "react";

import { ValueText } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const RuntimeBundleScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ValueText
      testID="runtime-bundle-id"
      value={model.runtimeSnapshot.bundleId}
    />
  );
};
