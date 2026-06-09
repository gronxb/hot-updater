import React from "react";
import { Text } from "react-native";

import { ScreenShell } from "../components";
import { styles } from "../styles";
import type { ScreenProps } from "./types";

export const CohortActionResultScreen = ({ model }: ScreenProps) => (
  <ScreenShell current="CohortActionResult">
    <Text selectable style={styles.resultText} testID="cohort-action-result">
      Cohort Action Result: {model.cohortActionResult}
    </Text>
  </ScreenShell>
);
