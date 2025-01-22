import { printBanner } from "@/components/banner";
import { ensureInstallPackages } from "@/utils/ensureInstallPackages";
import { isCancel, select } from "@clack/prompts";
import { initCloudflareD1R2 } from "./init/cloudflareD1R2";
import { initSupabase } from "./init/initSupabase";

const REQUIRED_PACKAGES = {
  dependencies: ["@hot-updater/react-native"],
  devDependencies: ["dotenv", "hot-updater"],
};

const PACKAGE_MAP = {
  supabase: {
    dependencies: [],
    devDependencies: ["@hot-updater/supabase"],
  },
  aws: {
    dependencies: [],
    devDependencies: ["@hot-updater/aws"],
  },
  "cloudflare-d1-r2": {
    dependencies: [],
    devDependencies: [],
    // devDependencies: ["@hot-updater/cloudflare"],
  },
} as const;

export const init = async () => {
  printBanner();

  const buildPluginPackage = await select({
    message: "Select a build plugin",
    options: [
      {
        value: {
          dependencies: [],
          devDependencies: ["@hot-updater/metro"],
        },
        label: "Metro",
      },
    ],
  });

  if (isCancel(buildPluginPackage)) {
    process.exit(0);
  }

  const provider = await select({
    message: "Select a provider",
    options: [
      { value: "supabase", label: "Supabase" },
      { value: "cloudflare-d1-r2", label: "Cloudflare D1 + R2" },
    ],
  });

  if (isCancel(provider)) {
    process.exit(0);
  }

  await ensureInstallPackages({
    dependencies: [
      ...buildPluginPackage.dependencies,
      ...REQUIRED_PACKAGES.dependencies,
      ...PACKAGE_MAP[provider].dependencies,
    ],
    devDependencies: [
      ...buildPluginPackage.devDependencies,
      ...REQUIRED_PACKAGES.devDependencies,
      ...PACKAGE_MAP[provider].devDependencies,
    ],
  });

  switch (provider) {
    case "supabase":
      await initSupabase();
      break;
    case "cloudflare-d1-r2":
      await initCloudflareD1R2();
      break;
    default:
      throw new Error("Invalid provider");
  }
};
