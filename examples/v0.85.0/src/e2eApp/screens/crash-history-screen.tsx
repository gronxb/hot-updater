import React from "react";
import { Text } from "react-native";

import { ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";
import { styles } from "../styles";

export const CrashHistoryScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell current="CrashHistory">
      <Text selectable style={styles.resultText} testID="crash-history-summary">
        {model.runtimeSnapshot.crashHistory.length === 0
          ? "No crashed bundles recorded."
          : `Crash History Count: ${model.runtimeSnapshot.crashHistory.length}`}
      </Text>
    </ScreenShell>
  );
};
