import { printBanner } from "@/components/banner";
import { ensureInstallPackages } from "@/utils/ensureInstallPackages";
import { isCancel, select } from "@clack/prompts";
import { initSupabase } from "./init/supabase";

const REQUIRED_PACKAGES = ["hot-updater", "@hot-updater/react-native"];

const PACKAGE_MAP = {
  supabase: ["@hot-updater/supabase"],
  aws: ["@hot-updater/aws"],
} as const;

export const init = async () => {
  printBanner();

  const buildPluginPackage = await select({
    message: "Select a build plugin",
    options: [{ value: "@hot-updater/metro", label: "Metro" }],
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

  await ensureInstallPackages([
    ...REQUIRED_PACKAGES,
    ...PACKAGE_MAP[provider],
    buildPluginPackage,
  ]);

  switch (provider) {
    case "supabase":
      await initSupabase();
      break;
    default:
      throw new Error("Invalid provider");
  }
};
