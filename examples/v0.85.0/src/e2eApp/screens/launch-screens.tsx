import React from "react";
import { Text } from "react-native";

import { ScreenShell, Section } from "../components";
import { styles } from "../styles";
import type { ScreenProps } from "./types";

export const LaunchStatusScreen = ({ model }: ScreenProps) => (
  <ScreenShell current="LaunchStatus">
    <Section title="Launch Status">
      <Text selectable style={styles.resultText} testID="launch-status-result">
        {model.launchStatusText}
      </Text>
    </Section>
  </ScreenShell>
);

export const LaunchCrashedBundleScreen = ({ model }: ScreenProps) => (
  <ScreenShell current="LaunchCrashedBundle">
    <Section title="Launch Crashed Bundle">
      <Text
        selectable
        style={styles.resultText}
        testID="launch-crashed-bundle-result"
      >
        {model.crashedBundleText}
      </Text>
    </Section>
  </ScreenShell>
);
