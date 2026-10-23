import React from "react";

import { Button } from "../components";

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
  <Button onPress={onPress} testID={testID} title={title} />
);
