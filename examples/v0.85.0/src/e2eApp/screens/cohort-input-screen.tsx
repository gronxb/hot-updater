import React from "react";
import { TextInput } from "react-native";

import { ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";
import { styles } from "../styles";

export const CohortInputScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell current="CohortInput">
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
    </ScreenShell>
  );
};
