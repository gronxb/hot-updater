import React from "react";
import { Text } from "react-native";

import { Button, ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";
import { styles } from "../styles";

export const SetCohortQaActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell current="SetCohortQaAction">
      <Button
        onPress={model.setCohortToQa}
        testID="action-set-cohort-qa"
        title="Set QA"
      />
      <Text style={styles.resultText} testID="cohort-action-result">
        Cohort Action Result: {model.cohortActionResult}
      </Text>
    </ScreenShell>
  );
};
