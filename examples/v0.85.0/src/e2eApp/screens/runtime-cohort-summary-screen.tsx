import React from "react";
import { Text } from "react-native";

import { ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";
import { styles } from "../styles";

export const RuntimeCohortSummaryScreen = () => {
  const model = useE2eRuntimeModelContext();
  const cohortSummary = `current=${model.runtimeSnapshot.cohort} initial=${model.initialCohort}`;

  return (
    <ScreenShell current="RuntimeCohortSummary">
      <Text
        selectable
        style={styles.resultText}
        testID="current-cohort-summary"
      >
        Current Cohort Summary: {cohortSummary}
      </Text>
    </ScreenShell>
  );
};
