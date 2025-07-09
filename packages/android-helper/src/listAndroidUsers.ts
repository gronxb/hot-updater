// highly credit to https://github.com/callstack/rnef/blob/main/packages/platform-android

import { select, spinner } from '@clack/prompts';
import { execa } from 'execa';
import { Adb } from './adb';

type User = {
  id: string;
  name: string;
};

const regex = new RegExp(
  /^\s*UserInfo\{(?<userId>\d+):(?<userName>.*):(?<userFlags>[0-9a-f]*)}/
);

/**
 * Check users on Android device
 */
export async function checkUsers(device: string): Promise<User[]> {
  const adbPath = Adb.getAdbPath();
  const adbArgs = ['-s', device, 'shell', 'pm', 'list', 'users'];
  const loader = spinner();
  loader.start(`Checking users on "${device}"`);

  try {
    const { stdout, stderr } = await execa(adbPath, adbArgs, { stdio: 'pipe' });

    if (stderr) {
      loader.stop(`Failed to check users of "${device}". ${stderr}`, 1);
      return [];
    }

    const lines = stdout.split('\n');
    const users = [];

    for (const line of lines) {
      const res = regex.exec(line);
      if (res?.groups?.userId && res?.groups?.userName) {
        users.push({ id: res.groups['userId'], name: res.groups['userName'] });
      }
    }

    loader.stop(`Found ${users.length} users on "${device}".`);
    return users as User[];
  } catch (error) {
    loader.stop(
      `Unexpected error while checking users of "${device}". Continuing without user selection. Error details: ${
        (error as { message: string }).message
      }.`,
      1
    );
    return [];
  }
}

/**
 * Prompt user to select user profile for app installation
 */
export async function promptForUser(deviceId: string) {
  const users = await checkUsers(deviceId);
  if (users.length > 1) {
    const selectedUser = await select({
      message: 'Which user profile would you like to launch your app into?',
      options: users.map((user) => ({
        label: user.name,
        value: user,
      })),
    });

    return selectedUser;
  }

  return null;
}
