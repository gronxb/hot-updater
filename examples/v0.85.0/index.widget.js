/**
 * E2E: the second React Native runtime the brownfield host shows under the
 * example when a scenario turns it on. Its native Hot Updater instance is
 * named `widget`, so its bundles, channel, and crash recovery stay apart from
 * the example's.
 *
 * @format
 */

import { AppRegistry } from 'react-native';
import { WidgetApp } from './src/widgetApp';
import { maybeCrashForE2E } from './src/widgetApp/patchSurface';

// A widget crash bundle throws while this runtime loads, before its first
// content, so the fatal belongs to the widget alone.
maybeCrashForE2E();

AppRegistry.registerComponent('HotUpdaterWidget', () => WidgetApp);
