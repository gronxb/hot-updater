import React from "react";
import { Text } from "react-native";

import { useE2eRuntimeModelContext } from "../runtime-model-context";
import { styles } from "../styles";

export const LaunchCrashedBundleScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <Text
      selectable
      style={styles.resultText}
      testID="launch-crashed-bundle-result"
    >
      {model.crashedBundleText}
    </Text>
  );
};
