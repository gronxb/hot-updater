import React from "react";
import { Text } from "react-native";

import { ScreenShell } from "../components";
import { styles } from "../styles";
import type { ScreenProps } from "./types";

export const LaunchStatusScreen = ({ model }: ScreenProps) => (
  <ScreenShell current="LaunchStatus">
    <Text selectable style={styles.resultText} testID="launch-status-result">
      {model.launchStatusText}
    </Text>
  </ScreenShell>
);
