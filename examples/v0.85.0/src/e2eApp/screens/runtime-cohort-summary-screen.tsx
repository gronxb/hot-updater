import React from "react";
import { Text } from "react-native";

import { ScreenShell, Section } from "../components";
import { styles } from "../styles";
import type { ScreenProps } from "./types";

export const RuntimeCohortSummaryScreen = ({ model }: ScreenProps) => {
  const cohortSummary = `current=${model.runtimeSnapshot.cohort} initial=${model.initialCohort}`;

  return (
    <ScreenShell current="RuntimeCohortSummary">
      <Section title="Runtime Cohort Summary">
        <Text
          selectable
          style={styles.resultText}
          testID="current-cohort-summary"
        >
          Current Cohort Summary: {cohortSummary}
        </Text>
      </Section>
    </ScreenShell>
  );
};
