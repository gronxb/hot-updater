import React from "react";
import { TextInput } from "react-native";

import { ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";
import { styles } from "../styles";

export const RuntimeChannelInputScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell current="RuntimeChannelInput">
      <TextInput
        accessibilityLabel="Runtime Channel Input"
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={model.setRuntimeChannelInput}
        placeholder="beta"
        placeholderTextColor="#6b7280"
        style={styles.input}
        testID="runtime-channel-input"
        value={model.runtimeChannelInput}
      />
    </ScreenShell>
  );
};
