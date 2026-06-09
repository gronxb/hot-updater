import React from "react";

import { InfoRow, ScreenShell, Section } from "../components";
import type { ScreenProps } from "./types";

export const UpdateStoreDownloadedScreen = ({ model }: ScreenProps) => (
  <ScreenShell current="UpdateStoreDownloaded">
    <Section title="Update Downloaded">
      <InfoRow
        label="Downloaded"
        value={String(model.isUpdateDownloaded)}
        valueTestID="update-store-downloaded"
      />
    </Section>
  </ScreenShell>
);

export const UpdateStoreDownloadPathsScreen = ({ model }: ScreenProps) => (
  <ScreenShell current="UpdateStoreDownloadPaths">
    <Section title="Update Download Paths">
      <InfoRow
        label="Download Paths"
        value={model.updateStoreDownloadPathsText}
        valueTestID="update-store-download-paths"
      />
    </Section>
  </ScreenShell>
);
