import React from "react";
import { AppRegistry } from "react-native";

import { hotUpdater } from "./e2eApp/runtime";

// A launch without UI runs the staged bundle but renders nothing. Android
// runs a headless task through HeadlessTaskService. iOS passes isHeadless when
// a silent push launches the app in the background, as React Native Firebase
// does.
const logHeadlessLaunch = () => {
  console.log(`HotUpdaterE2EHeadlessTask:${hotUpdater.getManifest().bundleId}`);
};

/**
 * Registers a target app's root component and the headless task the
 * headless-launch scenario starts.
 */
export function registerE2eApp(
  appName: string,
  App: React.ComponentType,
): void {
  function HeadlessCheck({ isHeadless }: { isHeadless?: boolean }) {
    if (isHeadless) {
      logHeadlessLaunch();
      return null;
    }
    return <App />;
  }
  AppRegistry.registerComponent(appName, () => HeadlessCheck);
  AppRegistry.registerHeadlessTask(
    "HotUpdaterE2EHeadlessTask",
    () => async () => {
      logHeadlessLaunch();
    },
  );
}
