import { ExecaError, execa } from "execa";
import { readPackageUp } from "read-package-up";
import { getCwd } from "./cwd.js";
import { getPackageManager } from "./getPackageManager.js";
import { p } from "./prompts.js";

export const ensureInstallPackages = async (
  packages: {
    dependencies?: string[];
    devDependencies?: string[];
  },
  options?: {
    versionResolver?: (pkg: string) => string;
  },
) => {
  const { versionResolver = (pkg: string) => pkg } = options ?? {};

  const pkgJson = await readPackageUp({ cwd: getCwd() });

  const dependenciesToInstall = (packages.dependencies ?? []).filter((pkg) => {
    return !pkgJson?.packageJson?.dependencies?.[pkg];
  });

  const devDependenciesToInstall = (packages.devDependencies ?? []).filter(
    (pkg) => {
      return !pkgJson?.packageJson?.devDependencies?.[pkg];
    },
  );

  const packageManager = getPackageManager();

  await p.tasks([
    {
      enabled: dependenciesToInstall.length > 0,
      title: "Installing dependencies",
      task: async (message) => {
        message(`Installing ${dependenciesToInstall.join(", ")}...`);
        try {
          const result = await execa(packageManager, [
            packageManager === "yarn" ? "add" : "install",
            ...dependenciesToInstall.map(versionResolver),
          ]);

          if (result.exitCode !== 0 && result.stderr) {
            p.log.error(result.stderr);
            process.exit(1);
          }

          return `Installed ${dependenciesToInstall.join(", ")}`;
        } catch (e) {
          if (e instanceof ExecaError) {
            p.log.error(e.stderr || e.stdout || e.message);
          } else if (e instanceof Error) {
            p.log.error(e.message);
          }
          process.exit(1);
        }
      },
    },
    {
      enabled: devDependenciesToInstall.length > 0,
      title: "Installing dev dependencies",
      task: async (message) => {
        message(`Installing ${devDependenciesToInstall.join(", ")}...`);
        try {
          const result = await execa(packageManager, [
            packageManager === "yarn" ? "add" : "install",
            ...devDependenciesToInstall.map(versionResolver),
            packageManager === "yarn" ? "--dev" : "--save-dev",
          ]);

          if (result.exitCode !== 0 && result.stderr) {
            p.log.error(result.stderr);
            process.exit(1);
          }

          return `Installed ${devDependenciesToInstall.join(", ")}`;
        } catch (e) {
          if (e instanceof ExecaError) {
            p.log.error(e.stderr || e.stdout || e.message);
          } else if (e instanceof Error) {
            p.log.error(e.message);
          }
          process.exit(1);
        }
      },
    },
  ]);
};
