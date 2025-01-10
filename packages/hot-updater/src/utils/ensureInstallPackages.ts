import * as p from "@clack/prompts";

import { getPackageManager } from "@/utils/getPackageManager";
import { getCwd } from "@hot-updater/plugin-core";
import { execa } from "execa";
import { readPackageUp } from "read-package-up";

export const ensureInstallPackages = async (buildPluginPackages: {
  dependencies: string[];
  devDependencies: string[];
}) => {
  const packages = await readPackageUp({ cwd: getCwd() });
  const dependenciesToInstall = buildPluginPackages.dependencies.filter(
    (pkg) => {
      return !packages?.packageJson?.dependencies?.[pkg];
    },
  );

  const devDependenciesToInstall = buildPluginPackages.devDependencies.filter(
    (pkg) => {
      return !packages?.packageJson?.devDependencies?.[pkg];
    },
  );

  const packageManager = getPackageManager();

  await p.tasks([
    {
      enabled: dependenciesToInstall.length > 0,
      title: "Checking packages",
      task: async (message) => {
        message(`Installing ${dependenciesToInstall.join(", ")}...`);
        await execa(packageManager, ["install", ...dependenciesToInstall]);
        return `Installed ${dependenciesToInstall.join(", ")}`;
      },
    },
    {
      enabled: devDependenciesToInstall.length > 0,
      title: "Installing dev dependencies",
      task: async (message) => {
        message(`Installing ${devDependenciesToInstall.join(", ")}...`);
        await execa(packageManager, [
          "install",
          ...devDependenciesToInstall,
          packageManager === "yarn" ? "--dev" : "--save-dev",
        ]);
        return `Installed ${devDependenciesToInstall.join(", ")}`;
      },
    },
  ]);
};
