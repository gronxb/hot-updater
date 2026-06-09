import React from "react";
import { Text } from "react-native";

import { ScreenShell, Section } from "../components";
import { styles } from "../styles";

export const ReadyScreen = () => (
  <ScreenShell current="Ready">
    <Section title="E2E Ready">
      <Text selectable style={styles.resultText} testID="e2e-ready-status">
        Ready
      </Text>
    </Section>
  </ScreenShell>
);
