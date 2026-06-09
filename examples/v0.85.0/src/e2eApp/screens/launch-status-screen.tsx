import React from "react";
import { Text } from "react-native";

import { ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";
import { styles } from "../styles";

export const LaunchStatusScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell>
      <Text selectable style={styles.resultText} testID="launch-status-result">
        {model.launchStatusText}
      </Text>
    </ScreenShell>
  );
};
