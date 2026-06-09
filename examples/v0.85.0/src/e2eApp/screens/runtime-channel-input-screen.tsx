import React from "react";
import { TextInput } from "react-native";

import { ScreenShell } from "../components";
import { styles } from "../styles";
import type { ScreenProps } from "./types";

export const RuntimeChannelInputScreen = ({ model }: ScreenProps) => (
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
