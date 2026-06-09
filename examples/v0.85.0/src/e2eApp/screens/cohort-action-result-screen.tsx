import React from "react";
import { Text } from "react-native";

import { ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";
import { styles } from "../styles";

export const CohortActionResultScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell>
      <Text selectable style={styles.resultText} testID="cohort-action-result">
        Cohort Action Result: {model.cohortActionResult}
      </Text>
    </ScreenShell>
  );
};
