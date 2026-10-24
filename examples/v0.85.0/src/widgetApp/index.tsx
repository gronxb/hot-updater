import React, { useEffect } from "react";
import { StyleSheet, Text, View } from "react-native";

import { patchE2eScreenState } from "@examples/e2e-app/config";
import { E2E_SCENARIO_MARKER, loadE2EDeployBundleAssets } from "./patchSurface";
import { hotUpdater } from "./runtime";

loadE2EDeployBundleAssets();

// The control server's screen state is shared by both runtimes, so the widget
// writes only its own key.
const publish = async (widgetState: string) => {
  try {
    await patchE2eScreenState({ widgetState });
  } catch (error) {
    console.warn(error instanceof Error ? error.message : String(error));
  }
};

/**
 * One always-visible panel: what this runtime runs. The host checks for the
 * widget's update natively before this runtime starts, so JavaScript only
 * calls `HotUpdater.init`. Every value has a `widget-` testID so it never
 * matches the example's.
 */
export const WidgetApp = () => {
  const bundleId = hotUpdater.getManifest().bundleId;

  useEffect(() => {
    void publish(`${bundleId} ${E2E_SCENARIO_MARKER}`);
  }, [bundleId]);

  return (
    <View style={styles.panel}>
      <Text style={styles.title}>Widget</Text>
      <Text selectable style={styles.value} testID="widget-bundle-id">
        {bundleId}
      </Text>
      <Text selectable style={styles.value} testID="widget-scenario-marker">
        {E2E_SCENARIO_MARKER}
      </Text>
      <Text selectable style={styles.value} testID="widget-channel">
        {hotUpdater.getChannel()}
      </Text>
      <Text selectable style={styles.value} testID="widget-crash-history-count">
        {String(hotUpdater.getCrashHistory().length)}
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  panel: {
    backgroundColor: "#ecfeff",
    flex: 1,
    paddingHorizontal: 18,
    paddingVertical: 8,
  },
  title: {
    color: "#155e75",
    fontSize: 13,
    fontWeight: "700",
  },
  value: {
    color: "#1f2937",
    fontSize: 12,
  },
});
