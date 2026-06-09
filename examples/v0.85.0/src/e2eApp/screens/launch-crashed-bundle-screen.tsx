import React from "react";
import { Text } from "react-native";

import { ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";
import { styles } from "../styles";

export const LaunchCrashedBundleScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell>
      <Text
        selectable
        style={styles.resultText}
        testID="launch-crashed-bundle-result"
      >
        {model.crashedBundleText}
      </Text>
    </ScreenShell>
  );
};
