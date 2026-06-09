import React from "react";

import { InfoRow, ScreenShell, Section } from "../components";
import type { ScreenProps } from "./types";

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
