import { ensureInstallPackages } from "@/utils/ensureInstallPackages";
import { printBanner } from "@/utils/printBanner";
import * as p from "@clack/prompts";
import { isCancel, select } from "@clack/prompts";
import { ExecaError } from "execa";

const REQUIRED_PACKAGES = {
  dependencies: ["@hot-updater/react-native"],
  devDependencies: ["dotenv"],
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
  cloudflare: {
    dependencies: [],
    devDependencies: ["wrangler", "@hot-updater/cloudflare"],
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
      {
        value: "cloudflare",
        label: "Cloudflare D1 + R2 + Worker",
      },
      { value: "aws", label: "AWS S3 + Lambda@Edge" },
    ],
  });

  if (isCancel(provider)) {
    process.exit(0);
  }

  try {
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
  } catch (e) {
    if (e instanceof ExecaError) {
      p.log.error(e.stderr ?? e.message);
    } else if (e instanceof Error) {
      p.log.error(e.message);
    }

    process.exit(1);
  }

  switch (provider) {
    case "supabase": {
      const supabase = await import("@hot-updater/supabase/iac");
      await supabase.runInit();
      break;
    }
    case "cloudflare": {
      const cloudflare = await import("@hot-updater/cloudflare/iac");
      await cloudflare.runInit();
      break;
    }
    case "aws": {
      const aws = await import("@hot-updater/aws/iac");
      await aws.runInit();
      break;
    }
    default:
      throw new Error("Invalid provider");
  }
};
