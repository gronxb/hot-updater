import * as p from "@clack/prompts";

import { getPackageManager } from "@/utils/getPackageManager";
import { execa } from "execa";

export const ensureInstallPackages = async (buildPluginPackages: {
  dependencies: string[];
  devDependencies: string[];
}) => {
  const dependenciesToInstall = buildPluginPackages.dependencies.filter(
    (pkg) => {
      try {
        require.resolve(pkg);
        return false;
      } catch {
        return true;
      }
    },
  );

  const devDependenciesToInstall = buildPluginPackages.devDependencies.filter(
    (pkg) => {
      try {
        require.resolve(pkg);
        return false;
      } catch {
        return true;
      }
    },
  );

  if (
    dependenciesToInstall.length === 0 &&
    devDependenciesToInstall.length === 0
  ) {
    return;
  }

  const packageManager = getPackageManager();

  await p.tasks([
    {
      title: "Checking packages",
      task: async (message) => {
        message(`Installing ${dependenciesToInstall.join(", ")}...`);
        await execa(packageManager, ["install", ...dependenciesToInstall]);
        return `Installed ${dependenciesToInstall.join(", ")}`;
      },
    },
    {
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
