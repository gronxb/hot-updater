import React from "react";
import { Text } from "react-native";

import { ScreenShell } from "../components";
import { styles } from "../styles";
import type { ScreenProps } from "./types";

export const ChannelActionResultScreen = ({ model }: ScreenProps) => (
  <ScreenShell current="ChannelActionResult">
    <Text selectable style={styles.resultText} testID="channel-action-result">
      Channel Action Result: {model.channelActionResult}
    </Text>
  </ScreenShell>
);
