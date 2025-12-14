import { ensureInstallPackages as ensureInstall } from "@hot-updater/cli-tools";
import { version } from "@/packageJson";

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
  await ensureInstall(buildPluginPackages, {
    versionResolver: ensurePackageVersion,
  });
};
