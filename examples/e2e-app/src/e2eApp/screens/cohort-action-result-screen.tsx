import React from "react";
import { Text } from "react-native";

import { useE2eRuntimeModelContext } from "../runtime-model-context";
import { styles } from "../styles";

export const CohortActionResultScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <Text selectable style={styles.resultText} testID="cohort-action-result">
      Cohort Action Result: {model.cohortActionResult}
    </Text>
  );
};
