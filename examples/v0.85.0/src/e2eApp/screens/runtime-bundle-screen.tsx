import React from "react";

import { InfoRow, ScreenShell, Section } from "../components";
import type { ScreenProps } from "./types";

export const RuntimeBundleScreen = ({ model }: ScreenProps) => (
  <ScreenShell current="RuntimeBundle">
    <Section title="Runtime Bundle">
      <InfoRow
        label="Bundle ID"
        value={model.runtimeSnapshot.bundleId}
        valueTestID="runtime-bundle-id"
      />
    </Section>
  </ScreenShell>
);
