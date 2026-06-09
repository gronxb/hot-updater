import React from "react";

import { InfoRow, ScreenShell } from "../components";
import type { ScreenProps } from "./types";

export const UpdateStoreDownloadPathsScreen = ({ model }: ScreenProps) => (
  <ScreenShell current="UpdateStoreDownloadPaths">
    <InfoRow
      label="Download Paths"
      value={model.updateStoreDownloadPathsText}
      valueTestID="update-store-download-paths"
    />
  </ScreenShell>
);
