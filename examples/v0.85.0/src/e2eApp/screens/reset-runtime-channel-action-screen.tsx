import React from "react";
import { Text } from "react-native";

import { Button, ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";
import { styles } from "../styles";

export const ResetRuntimeChannelActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell current="ResetRuntimeChannelAction">
      <Button
        onPress={model.resetRuntimeChannel}
        testID="action-reset-runtime-channel"
        title="Reset Channel"
      />
      <Text style={styles.resultText} testID="channel-action-result">
        Channel Action Result: {model.channelActionResult}
      </Text>
    </ScreenShell>
  );
};
