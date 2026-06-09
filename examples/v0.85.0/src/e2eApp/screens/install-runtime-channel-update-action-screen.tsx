import React from "react";
import { Text } from "react-native";

import { Button, ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";
import { styles } from "../styles";

export const InstallRuntimeChannelUpdateActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell current="InstallRuntimeChannelUpdateAction">
      <Button
        onPress={model.installRuntimeChannelUpdate}
        testID="action-install-runtime-channel-update"
        title="Install Runtime"
      />
      <Text style={styles.resultText} testID="channel-action-result">
        Channel Action Result: {model.channelActionResult}
      </Text>
    </ScreenShell>
  );
};
