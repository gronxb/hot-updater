import React from "react";

import { hotUpdater } from "../runtime";
import { ActionButtonScreen } from "./action-button-screen";

export const ClearUpdateLogsActionScreen = () => (
  <ActionButtonScreen
    onPress={async () => {
      await hotUpdater.clearUpdateLogs();
    }}
    testID="action-clear-update-logs"
    title="Clear Update Logs"
  />
);
