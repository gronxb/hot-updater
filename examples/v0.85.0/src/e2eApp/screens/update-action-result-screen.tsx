import React from "react";
import { Text } from "react-native";

import { ScreenShell, Section } from "../components";
import { styles } from "../styles";
import type { ScreenProps } from "./types";

export const UpdateActionResultScreen = ({ model }: ScreenProps) => (
  <ScreenShell current="UpdateActionResult">
    <Section title="Update Action Result" titleTestID="section-action-results">
      <Text selectable style={styles.resultText} testID="update-action-result">
        Update Action Result: {model.updateActionResult}
      </Text>
    </Section>
  </ScreenShell>
);
