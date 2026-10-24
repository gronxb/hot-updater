/**
 * @format
 */

import { registerE2eApp } from '@examples/e2e-app';
import App from './App';
import { name as appName } from './app.json';

registerE2eApp(appName, App);
