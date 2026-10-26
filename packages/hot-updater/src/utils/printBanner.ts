import { printBanner as _printBanner } from "@hot-updater/cli-tools";

import { version } from "@/packageJson";

let printed = false;

/**
 * Prints the banner once per run, so a command that runs another's handler,
 * such as `testflight` running `build:ios`'s, prints it once.
 */
export const printBanner = () => {
  if (printed) return;
  printed = true;
  _printBanner(version);
};
