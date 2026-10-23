import React from "react";
import { Text } from "react-native";

import { useE2eRuntimeModelContext } from "../runtime-model-context";
import { styles } from "../styles";

export const UpdateActionResultText = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <Text selectable style={styles.resultText} testID="update-action-result">
      {model.updateActionResult}
    </Text>
  );
};

export const UpdateActionResultScreen = () => {
  return <UpdateActionResultText />;
};
