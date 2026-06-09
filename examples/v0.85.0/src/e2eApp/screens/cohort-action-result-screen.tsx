import React from "react";
import { Text } from "react-native";

import { ScreenShell, Section } from "../components";
import { styles } from "../styles";
import type { ScreenProps } from "./types";

export const CohortActionResultScreen = ({ model }: ScreenProps) => (
  <ScreenShell current="CohortActionResult">
    <Section title="Cohort Action Result" titleTestID="section-action-results">
      <Text selectable style={styles.resultText} testID="cohort-action-result">
        Cohort Action Result: {model.cohortActionResult}
      </Text>
    </Section>
  </ScreenShell>
);
