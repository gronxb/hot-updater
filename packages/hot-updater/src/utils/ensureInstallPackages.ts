import * as p from "@clack/prompts";

import { getPackageManager } from "@/utils/getPackageManager";
import { execa } from "execa";

export const ensureInstallPackages = async (buildPluginPackages: string[]) => {
  const packagesToInstall = buildPluginPackages.filter((pkg) => {
    try {
      require.resolve(pkg);
      return false;
    } catch {
      return true;
    }
  });

  if (packagesToInstall.length === 0) {
    return;
  }

  await p.tasks([
    {
      title: "Checking packages",
      task: async (message) => {
        const packageManager = getPackageManager();
        message(`Installing ${packagesToInstall.join(", ")}...`);
        await execa(packageManager, ["install", ...packagesToInstall]);
        return `Installed ${packagesToInstall.join(", ")}`;
      },
    },
  ]);
};
