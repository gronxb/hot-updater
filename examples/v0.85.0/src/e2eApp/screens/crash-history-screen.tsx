import React from "react";
import { Text } from "react-native";

import { ScreenShell, Section } from "../components";
import { styles } from "../styles";
import type { ScreenProps } from "./types";

export const CrashHistoryScreen = ({ model }: ScreenProps) => (
  <ScreenShell current="CrashHistory">
    <Section
      title={`Crash History (${model.runtimeSnapshot.crashHistory.length})`}
      titleTestID="section-crash-history"
    >
      <Text selectable style={styles.resultText} testID="crash-history-summary">
        {model.runtimeSnapshot.crashHistory.length === 0
          ? "No crashed bundles recorded."
          : `Crash History Count: ${model.runtimeSnapshot.crashHistory.length}`}
      </Text>
    </Section>
  </ScreenShell>
);
