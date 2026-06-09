import React from "react";
import { Text } from "react-native";

import { ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";
import { styles } from "../styles";

export const UpdateActionResultText = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <Text selectable style={styles.resultText} testID="update-action-result">
      Update Action Result: {model.updateActionResult}
    </Text>
  );
};

export const UpdateActionResultScreen = () => {
  return (
    <ScreenShell>
      <UpdateActionResultText />
    </ScreenShell>
  );
};
