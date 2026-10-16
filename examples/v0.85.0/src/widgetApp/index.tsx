import React, { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { patchE2eScreenState } from "../e2eRuntimeConfig";
import { E2E_SCENARIO_MARKER, loadE2EDeployBundleAssets } from "./patchSurface";
import { hotUpdater } from "./runtime";

loadE2EDeployBundleAssets();

const LABEL = "widget";

// The control server's screen state is shared by both runtimes, so the widget
// writes only its own keys.
const publish = async (patch: {
  widgetState?: string;
  widgetUpdateResult?: string;
}) => {
  try {
    await patchE2eScreenState(patch);
  } catch (error) {
    console.warn(error instanceof Error ? error.message : String(error));
  }
};

// Stages the widget's update for its next start. A named runtime never
// reloads: `reload` rejects there, and the host decides when it restarts.
const stageUpdate = async (): Promise<string> => {
  try {
    const updateInfo = await hotUpdater.checkForUpdate({
      updateStrategy: "appVersion",
    });
    if (!updateInfo) return `${LABEL} -> no-update`;
    if (!(await updateInfo.updateBundle())) return `${LABEL} -> skipped`;
    if (updateInfo.transitionKind === "USE_BUILTIN") {
      return `${LABEL} -> selected BUILTIN`;
    }
    if (updateInfo.transitionKind === "ADOPT_RELEASE") {
      return `${LABEL} -> adopted ID ${updateInfo.id}`;
    }
    return `${LABEL} -> installed ID ${updateInfo.id}`;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to install update";
    return `${LABEL} -> error ${message}`;
  }
};

/**
 * One always-visible panel: what this runtime runs, and what its update check
 * did. Every value has a `widget-` testID so it never matches the example's.
 */
export const WidgetApp = () => {
  const bundleId = hotUpdater.getManifest().bundleId;
  const [updateResult, setUpdateResult] = useState(`${LABEL} -> checking`);
  const [crashHistoryCount, setCrashHistoryCount] = useState(
    () => hotUpdater.getCrashHistory().length,
  );

  useEffect(() => {
    let active = true;
    void (async () => {
      await publish({
        widgetState: `${bundleId} ${E2E_SCENARIO_MARKER}`,
        widgetUpdateResult: `${LABEL} -> checking`,
      });
      const result = await stageUpdate();
      if (!active) return;
      setUpdateResult(result);
      setCrashHistoryCount(hotUpdater.getCrashHistory().length);
      await publish({ widgetUpdateResult: result });
    })();
    return () => {
      active = false;
    };
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
        {String(crashHistoryCount)}
      </Text>
      <Text selectable style={styles.value} testID="widget-update-result">
        {updateResult}
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
