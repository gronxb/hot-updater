import React from "react";

import { Button, ScreenShell, Section } from "../components";
import type { ScreenName } from "../types";

type ActionButtonScreenProps = {
  readonly current: ScreenName;
  readonly onPress: () => Promise<void> | void;
  readonly testID: string;
  readonly title: string;
};

export const ActionButtonScreen = ({
  current,
  onPress,
  testID,
  title,
}: ActionButtonScreenProps) => (
  <ScreenShell current={current}>
    <Section title={title}>
      <Button onPress={onPress} testID={testID} title={title} />
    </Section>
  </ScreenShell>
);
