import React from "react";
import { Text } from "react-native";

import { ScreenShell, Section } from "../components";
import { styles } from "../styles";
import type { ScreenProps } from "./types";

export const ChannelActionResultScreen = ({ model }: ScreenProps) => (
  <ScreenShell current="ChannelActionResult">
    <Section title="Channel Action Result" titleTestID="section-action-results">
      <Text selectable style={styles.resultText} testID="channel-action-result">
        Channel Action Result: {model.channelActionResult}
      </Text>
    </Section>
  </ScreenShell>
);
