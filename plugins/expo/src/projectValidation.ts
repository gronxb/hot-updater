import fs from "node:fs";
import path from "node:path";

import { getPackageManager, p } from "@hot-updater/cli-tools";
import type { IntegrationCommand } from "@hot-updater/plugin-core";

const hasDependency = (cwd: string, dependency: string): boolean => {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(cwd, "package.json"), "utf8"),
    );
    return [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.optionalDependencies,
      manifest.peerDependencies,
    ].some((dependencies) => dependencies?.[dependency] !== undefined);
  } catch {
    return false;
  }
};

const usesContinuousNativeGeneration = (cwd: string): boolean => {
  const appJsonPath = path.join(cwd, "app.json");
  if (fs.existsSync(appJsonPath)) {
    try {
      if (JSON.parse(fs.readFileSync(appJsonPath, "utf8")).expo) return true;
    } catch {}
  }
  return ["js", "mjs", "cjs", "ts", "mts", "cts"].some((extension) =>
    fs.existsSync(path.join(cwd, `app.config.${extension}`)),
  );
};

const nativeMutationCommands = new Set<IntegrationCommand>([
  "channel:set",
  "fingerprint:create",
  "keys:export-public",
  "keys:remove",
]);

export const validateExpoProject = ({
  command,
  cwd,
}: {
  command: IntegrationCommand;
  cwd: string;
}): void => {
  if (hasDependency(cwd, "expo-updates")) {
    const packageManager = getPackageManager();
    const removeCommand = packageManager === "npm" ? "uninstall" : "remove";
    throw new Error(
      `expo-updates and Hot Updater cannot manage the same app. Remove it with \`${packageManager} ${removeCommand} expo-updates\` before continuing.`,
    );
  }

  if (
    !nativeMutationCommands.has(command) ||
    !usesContinuousNativeGeneration(cwd)
  ) {
    return;
  }

  p.log.warn("Expo CNG project detected.");
  p.log.info(
    "Configure the @hot-updater/expo plugin in app.json or app.config, then run `npx expo prebuild`.",
  );
};
