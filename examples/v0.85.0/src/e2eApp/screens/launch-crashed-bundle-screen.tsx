import React from "react";
import { Text } from "react-native";

import { ScreenShell } from "../components";
import { styles } from "../styles";
import type { ScreenProps } from "./types";

export const LaunchCrashedBundleScreen = ({ model }: ScreenProps) => (
  <ScreenShell current="LaunchCrashedBundle">
    <Text
      selectable
      style={styles.resultText}
      testID="launch-crashed-bundle-result"
    >
      {model.crashedBundleText}
    </Text>
  </ScreenShell>
);
