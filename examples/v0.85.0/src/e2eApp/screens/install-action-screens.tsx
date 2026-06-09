import React from "react";

import { ActionButtonScreen } from "./action-button-screen";
import type { ScreenProps } from "./types";

export const InstallCurrentChannelUpdateActionScreen = ({
  model,
}: ScreenProps) => (
  <ActionButtonScreen
    current="InstallCurrentChannelUpdateAction"
    onPress={() => model.installUpdate({ actionLabel: "current-channel" })}
    testID="action-install-current-channel-update"
    title="Install Current"
  />
);

export const InstallRuntimeChannelUpdateActionScreen = ({
  model,
}: ScreenProps) => (
  <ActionButtonScreen
    current="InstallRuntimeChannelUpdateAction"
    onPress={model.installRuntimeChannelUpdate}
    testID="action-install-runtime-channel-update"
    title="Install Runtime"
  />
);
