import * as p from "@clack/prompts";
import type { Platform } from "@hot-updater/plugin-core";
import { ExecaError, execa } from "execa";

/**
 * Run expo `prebuild` command
 */
export const runExpoPrebuild = async ({ platform }: { platform: Platform }) => {
  // Don't install or clean at not
  try {
    const args = [
      "expo",
      "prebuild",
      "--platform",
      platform,
      "--no-install",
      "--clean",
      String(false),
    ];
    await execa("npx", args);
  } catch (e) {
    if (e instanceof ExecaError) {
      p.log.error(e.stderr || e.stdout || e.message);
    } else if (e instanceof Error) {
      p.log.error(e.message);
    }
    process.exit(1);
  }
};
