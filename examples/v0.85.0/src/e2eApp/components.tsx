import React, { type ReactNode, useState } from "react";
import { Pressable, SafeAreaView, Text, View } from "react-native";

import { styles } from "./styles";

export const InfoRow = ({
  label,
  value,
  valueTestID,
}: {
  readonly label: string;
  readonly value: string;
  readonly valueTestID?: string;
}) => (
  <View style={styles.infoRow}>
    <Text style={styles.infoLabel}>{label}</Text>
    <Text selectable style={styles.infoValue} testID={valueTestID}>
      {value}
    </Text>
  </View>
);

export const Button = ({
  onPress,
  testID,
  title,
}: {
  readonly onPress: () => Promise<void> | void;
  readonly testID: string;
  readonly title: string;
}) => (
  <Pressable
    accessibilityLabel={title}
    accessibilityRole="button"
    onPress={() => {
      void onPress();
    }}
    style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
    testID={testID}
  >
    <Text style={styles.buttonText}>{title}</Text>
  </Pressable>
);

export const ActionButtonWithStartCount = ({
  onPress,
  testID,
  title,
}: {
  readonly onPress: () => Promise<void> | void;
  readonly testID: string;
  readonly title: string;
}) => {
  const [startCount, setStartCount] = useState(0);

  return (
    <>
      <Button
        onPress={() => {
          setStartCount((current) => current + 1);
          return onPress();
        }}
        testID={testID}
        title={title}
      />
      <Text
        selectable
        style={styles.resultText}
        testID={`${testID}-start-count`}
      >
        Action Start Count: {startCount}
      </Text>
    </>
  );
};

export const ScreenShell = ({ children }: { readonly children: ReactNode }) => (
  <SafeAreaView style={styles.safeArea}>
    <View style={styles.content}>{children}</View>
  </SafeAreaView>
);
