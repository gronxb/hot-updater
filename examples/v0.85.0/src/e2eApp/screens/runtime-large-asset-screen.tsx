import React from "react";

import { InfoRow, ScreenShell } from "../components";
import { E2E_LARGE_ARCHIVE_ASSET_MANIFEST_PATH } from "../runtime";
import type { ScreenProps } from "./types";

export const RuntimeLargeAssetScreen = ({ model }: ScreenProps) => {
  const hasLargeE2EAsset = Object.keys(
    model.runtimeSnapshot.manifest.assets,
  ).includes(E2E_LARGE_ARCHIVE_ASSET_MANIFEST_PATH);

  return (
    <ScreenShell current="RuntimeLargeAsset">
      <InfoRow
        label="Large Asset"
        value={hasLargeE2EAsset ? "present" : "missing"}
        valueTestID="runtime-large-e2e-asset"
      />
    </ScreenShell>
  );
};
