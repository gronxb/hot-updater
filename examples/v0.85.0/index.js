/**
 * @format
 */

import { HotUpdater } from '@hot-updater/react-native';
import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

// E2E: a launch without UI runs the staged bundle but renders nothing. Android
// runs a headless task through HeadlessTaskService. iOS passes isHeadless when
// a silent push launches the app in the background, as React Native Firebase
// does.
const logHeadlessLaunch = () => {
  console.log(`HotUpdaterE2EHeadlessTask:${HotUpdater.getManifest().bundleId}`);
};

function HeadlessCheck({ isHeadless }) {
  if (isHeadless) {
    logHeadlessLaunch();
    return null;
  }
  return <App />;
}

AppRegistry.registerComponent(appName, () => HeadlessCheck);
AppRegistry.registerHeadlessTask('HotUpdaterE2EHeadlessTask', () => async () => {
  logHeadlessLaunch();
});
