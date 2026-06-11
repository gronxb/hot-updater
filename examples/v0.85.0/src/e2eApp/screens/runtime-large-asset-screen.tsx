import React from "react";

import { ValueText } from "../components";
import { E2E_LARGE_ARCHIVE_ASSET_MANIFEST_PATH } from "../runtime";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const RuntimeLargeAssetScreen = () => {
  const model = useE2eRuntimeModelContext();
  const hasLargeE2EAsset = Object.keys(
    model.runtimeSnapshot.manifest.assets,
  ).includes(E2E_LARGE_ARCHIVE_ASSET_MANIFEST_PATH);

  return (
    <ValueText
      testID="runtime-large-e2e-asset"
      value={hasLargeE2EAsset ? "present" : "missing"}
    />
  );
};
