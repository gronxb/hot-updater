import React from "react";
import { Text } from "react-native";

import { ScreenShell, Section } from "../components";
import { styles } from "../styles";
import type { ScreenProps } from "./types";

export const ChannelActionResultScreen = ({ model }: ScreenProps) => (
  <ScreenShell current="ChannelActionResult">
    <Section title="Channel Action Result" titleTestID="section-action-results">
      <Text selectable style={styles.resultText} testID="channel-action-result">
        Channel Action Result: {model.channelActionResult}
      </Text>
    </Section>
  </ScreenShell>
);

export const UpdateActionResultScreen = ({ model }: ScreenProps) => (
  <ScreenShell current="UpdateActionResult">
    <Section title="Update Action Result" titleTestID="section-action-results">
      <Text selectable style={styles.resultText} testID="update-action-result">
        Update Action Result: {model.updateActionResult}
      </Text>
    </Section>
  </ScreenShell>
);

export const CohortActionResultScreen = ({ model }: ScreenProps) => (
  <ScreenShell current="CohortActionResult">
    <Section title="Cohort Action Result" titleTestID="section-action-results">
      <Text selectable style={styles.resultText} testID="cohort-action-result">
        Cohort Action Result: {model.cohortActionResult}
      </Text>
    </Section>
  </ScreenShell>
);
