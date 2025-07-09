// highly credit to https://github.com/callstack/rnef/blob/main/packages/platform-android

import { Adb, type User } from './adb';

/**
 * Check users on Android device
 */
export const checkUsers = Adb.checkUsers;

/**
 * Prompt user to select user profile for app installation
 */
export const promptForUser = Adb.promptForUser;

export type { User };
