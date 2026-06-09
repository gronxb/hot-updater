import React from "react";

import { InfoRow, ScreenShell } from "../components";
import type { ScreenProps } from "./types";

export const UpdateStoreDownloadedScreen = ({ model }: ScreenProps) => (
  <ScreenShell current="UpdateStoreDownloaded">
    <InfoRow
      label="Downloaded"
      value={String(model.isUpdateDownloaded)}
      valueTestID="update-store-downloaded"
    />
  </ScreenShell>
);
