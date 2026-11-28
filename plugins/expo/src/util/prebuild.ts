import { p } from "@hot-updater/cli-tools";
import type { Platform } from "@hot-updater/plugin-core";
import { ExecaError, execa } from "execa";

/**
 * Run expo `prebuild` command
 */
export const runExpoPrebuild = async ({ platform }: { platform: Platform }) => {
  // Don't install or clean at not
  const spinner = p.spinner();
  try {
    spinner.start("Running expo prebuild");
    const args = ["expo", "prebuild", "--platform", platform, "--no-install"];
    await execa("npx", args);
    spinner.stop("Expo prebuild done");
  } catch (e) {
    spinner.error("Expo prebuild failed");
    if (e instanceof ExecaError) {
      p.log.error(e.stderr || e.stdout || e.message);
    } else if (e instanceof Error) {
      p.log.error(e.message);
    }
    process.exit(1);
  }
};
