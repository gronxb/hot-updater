/**
 * @format
 */

import { HotUpdater } from '@hot-updater/react-native';
import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
// E2E: HeadlessTaskService runs this without an activity, the way messaging
// libraries run JS for a background push.
AppRegistry.registerHeadlessTask('HotUpdaterE2EHeadlessTask', () => async () => {
  console.log(`HotUpdaterE2EHeadlessTask:${HotUpdater.getManifest().bundleId}`);
});
