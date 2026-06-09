import React from "react";
import { Text } from "react-native";

import { ScreenShell, Section } from "../components";
import { styles } from "../styles";
import type { ScreenProps } from "./types";

export const RuntimeChannelSummaryScreen = ({ model }: ScreenProps) => {
  const channelSummary = `current=${model.runtimeSnapshot.channel} default=${
    model.runtimeSnapshot.defaultChannel
  } switched=${String(model.runtimeSnapshot.isChannelSwitched)}`;

  return (
    <ScreenShell current="RuntimeChannelSummary">
      <Section title="Runtime Channel Summary">
        <Text
          selectable
          style={styles.resultText}
          testID="current-channel-summary"
        >
          Current Channel Summary: {channelSummary}
        </Text>
      </Section>
    </ScreenShell>
  );
};
