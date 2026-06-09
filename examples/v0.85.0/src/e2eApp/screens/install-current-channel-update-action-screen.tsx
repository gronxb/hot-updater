import React from "react";
import { Text } from "react-native";

import { Button, ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";
import { styles } from "../styles";

export const InstallCurrentChannelUpdateActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell current="InstallCurrentChannelUpdateAction">
      <Button
        onPress={() => model.installUpdate({ actionLabel: "current-channel" })}
        testID="action-install-current-channel-update"
        title="Install Current"
      />
      <Text style={styles.resultText} testID="update-action-result">
        Update Action Result: {model.updateActionResult}
      </Text>
    </ScreenShell>
  );
};
