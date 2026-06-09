import React from "react";

import { ActionButtonWithStartCount, ScreenShell } from "../components";

type ActionButtonScreenProps = {
  readonly onPress: () => Promise<void> | void;
  readonly testID: string;
  readonly title: string;
};

export const ActionButtonScreen = ({
  onPress,
  testID,
  title,
}: ActionButtonScreenProps) => (
  <ScreenShell>
    <ActionButtonWithStartCount
      onPress={onPress}
      testID={testID}
      title={title}
    />
  </ScreenShell>
);
