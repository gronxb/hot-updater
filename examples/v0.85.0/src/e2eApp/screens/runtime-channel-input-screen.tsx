import React from "react";
import { TextInput } from "react-native";

import { ScreenShell, Section } from "../components";
import { styles } from "../styles";
import type { ScreenProps } from "./types";

export const RuntimeChannelInputScreen = ({ model }: ScreenProps) => (
  <ScreenShell current="RuntimeChannelInput">
    <Section title="Runtime Channel">
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
    </Section>
  </ScreenShell>
);
