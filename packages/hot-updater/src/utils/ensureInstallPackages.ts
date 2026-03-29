import {
  ensureInstallPackages as ensureInstall,
  HOT_UPDATER_SERVER_PACKAGE_VERSION_ENV,
} from "@hot-updater/cli-tools";
import { version } from "@/packageJson";

const PROVIDER_PACKAGES = {
  aws: "@hot-updater/aws",
  cloudflare: "@hot-updater/cloudflare",
  firebase: "@hot-updater/firebase",
  supabase: "@hot-updater/supabase",
} as const;

type ProviderName = keyof typeof PROVIDER_PACKAGES;

const isUrlLike = (value: string) => {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
};

const ensurePackageVersion = (pkg: string, provider?: ProviderName) => {
  const override = process.env[HOT_UPDATER_SERVER_PACKAGE_VERSION_ENV]?.trim();
  const providerPackage = provider ? PROVIDER_PACKAGES[provider] : undefined;

  if (override && providerPackage === pkg) {
    return isUrlLike(override) ? override : `${pkg}@${override}`;
  }

  if (pkg === "hot-updater" || pkg.startsWith("@hot-updater/")) {
    return `${pkg}@${version}`;
  }
  return pkg;
};

export const ensureInstallPackages = async (
  buildPluginPackages: {
    dependencies: string[];
    devDependencies: string[];
  },
  options?: { provider?: ProviderName },
) => {
  await ensureInstall(buildPluginPackages, {
    versionResolver: (pkg) => ensurePackageVersion(pkg, options?.provider),
  });
};
