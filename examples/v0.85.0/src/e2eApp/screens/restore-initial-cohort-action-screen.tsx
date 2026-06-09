import React from "react";
import { Text } from "react-native";

import { Button, ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";
import { styles } from "../styles";

export const RestoreInitialCohortActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell current="RestoreInitialCohortAction">
      <Button
        onPress={model.restoreInitialCohort}
        testID="action-restore-initial-cohort"
        title="Restore Cohort"
      />
      <Text style={styles.resultText} testID="cohort-action-result">
        Cohort Action Result: {model.cohortActionResult}
      </Text>
    </ScreenShell>
  );
};
