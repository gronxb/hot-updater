import React from "react";
import { Text } from "react-native";

import { useE2eRuntimeModelContext } from "../runtime-model-context";
import { styles } from "../styles";

export const LaunchStatusScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <Text selectable style={styles.resultText} testID="launch-status-result">
      {model.launchStatusText}
    </Text>
  );
};
