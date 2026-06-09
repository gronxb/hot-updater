import React from "react";
import { Text } from "react-native";

import { Button, ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";
import { styles } from "../styles";

export const ApplyCohortInputActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell current="ApplyCohortInputAction">
      <Button
        onPress={model.applyCohortInput}
        testID="action-apply-cohort-input"
        title="Apply Cohort"
      />
      <Text style={styles.resultText} testID="cohort-action-result">
        Cohort Action Result: {model.cohortActionResult}
      </Text>
    </ScreenShell>
  );
};
