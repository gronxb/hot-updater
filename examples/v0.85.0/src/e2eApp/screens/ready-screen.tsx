import React from "react";
import { Text } from "react-native";

import { ScreenShell } from "../components";
import { styles } from "../styles";

export const ReadyScreen = () => (
  <ScreenShell current="Ready">
    <Text selectable style={styles.resultText} testID="e2e-ready-status">
      Ready
    </Text>
  </ScreenShell>
);
