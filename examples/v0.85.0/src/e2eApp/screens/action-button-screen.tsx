import React from "react";

import { Button, ScreenShell } from "../components";
import type { ScreenName } from "../types";

type ActionButtonScreenProps = {
  readonly current: ScreenName;
  readonly deferPress?: boolean;
  readonly onPress: () => Promise<void> | void;
  readonly testID: string;
  readonly title: string;
};

export const ActionButtonScreen = ({
  current,
  deferPress = false,
  onPress,
  testID,
  title,
}: ActionButtonScreenProps) => (
  <ScreenShell current={current}>
    <Button
      deferPress={deferPress}
      onPress={onPress}
      testID={testID}
      title={title}
    />
  </ScreenShell>
);
