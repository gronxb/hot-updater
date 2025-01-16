import * as p from "@clack/prompts";

import { version } from "@/packageJson";
import { getPackageManager } from "@/utils/getPackageManager";
import { getCwd } from "@hot-updater/plugin-core";
import { execa } from "execa";
import { readPackageUp } from "read-package-up";

const ensurePackageVersion = (pkg: string) => {
  if (pkg === "hot-updater" || pkg.startsWith("@hot-updater/")) {
    return `${pkg}@${version}`;
  }
  return pkg;
};

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
        await execa(packageManager, [
          "install",
          ...dependenciesToInstall.map(ensurePackageVersion),
          packageManager === "yarn" ? "--dev" : "--save-dev",
        ]);
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
          ...devDependenciesToInstall.map(ensurePackageVersion),
          packageManager === "yarn" ? "--dev" : "--save-dev",
        ]);
        return `Installed ${devDependenciesToInstall.join(", ")}`;
      },
    },
  ]);
};
