import React from "react";
import { Text } from "react-native";

import { ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";
import { styles } from "../styles";

export const RuntimeChannelSummaryScreen = () => {
  const model = useE2eRuntimeModelContext();
  const channelSummary = `current=${model.runtimeSnapshot.channel} default=${
    model.runtimeSnapshot.defaultChannel
  } switched=${String(model.runtimeSnapshot.isChannelSwitched)}`;

  return (
    <ScreenShell current="RuntimeChannelSummary">
      <Text
        selectable
        style={styles.resultText}
        testID="current-channel-summary"
      >
        Current Channel Summary: {channelSummary}
      </Text>
    </ScreenShell>
  );
};
