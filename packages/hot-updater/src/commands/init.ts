import { printBanner } from "@/components/banner";
import { ensureInstallPackages } from "@/utils/ensureInstallPackages";
import { isCancel, select } from "@clack/prompts";
import { initSupabase } from "./init/supabase";

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
    options: [{ value: "supabase", label: "Supabase" }],
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
    default:
      throw new Error("Invalid provider");
  }
};
