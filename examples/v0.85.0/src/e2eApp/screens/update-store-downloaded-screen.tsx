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
