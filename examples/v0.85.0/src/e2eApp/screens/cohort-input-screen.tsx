import React from "react";
import { TextInput } from "react-native";

import { ScreenShell, Section } from "../components";
import { styles } from "../styles";
import type { ScreenProps } from "./types";

export const CohortInputScreen = ({ model }: ScreenProps) => (
  <ScreenShell current="CohortInput">
    <Section title="Cohort Input">
      <TextInput
        accessibilityLabel="Cohort Override Input"
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={model.updateCohortInput}
        onEndEditing={(event) =>
          model.updateCohortInput(event.nativeEvent.text)
        }
        placeholder={model.initialCohort}
        placeholderTextColor="#6b7280"
        selectTextOnFocus={true}
        style={styles.input}
        testID="cohort-input"
        value={model.cohortInput}
      />
    </Section>
  </ScreenShell>
);
