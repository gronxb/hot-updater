import type { BuildType } from "@hot-updater/cli-tools";
import { p } from "@hot-updater/cli-tools";
import { HotUpdateDirUtil } from "@hot-updater/core";
import { ExecaError } from "execa";
import { ensureInstallPackages } from "@/utils/ensureInstallPackages";
import { appendToProjectRootGitignore } from "@/utils/git";
import { printBanner } from "@/utils/printBanner";

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
  firebase: {
    dependencies: [],
    devDependencies: [
      "firebase-tools",
      "firebase-admin",
      "@hot-updater/firebase",
    ],
  },
} as const;

export const init = async () => {
  printBanner();

  const buildPluginPackage = await p.select({
    message: "Select a build plugin",
    options: [
      {
        value: {
          name: "bare",
          dependencies: [],
          devDependencies: ["@hot-updater/bare"],
        },
        hint: "React Native CLI",
        label: "Bare",
      },
      {
        value: {
          name: "rock",
          dependencies: [],
          devDependencies: ["@hot-updater/rock"],
        },
        hint: "React Native Enterprise Framework by Callstack",
        label: "Rock",
      },
      {
        value: {
          name: "expo",
          dependencies: [],
          devDependencies: ["@hot-updater/expo"],
        },
        label: "Expo",
      },
    ],
  });

  if (p.isCancel(buildPluginPackage)) {
    process.exit(0);
  }

  const provider = await p.select({
    message: "Select a provider",
    options: [
      { value: "supabase", label: "Supabase" },
      {
        value: "cloudflare",
        label: "Cloudflare D1 + R2 + Worker",
      },
      { value: "aws", label: "AWS S3 + Lambda@Edge" },
      { value: "firebase", label: "Firebase" },
    ],
  });

  if (p.isCancel(provider)) {
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

  const build = buildPluginPackage.name as BuildType;
  switch (provider) {
    case "supabase": {
      const supabase = await import("@hot-updater/supabase/iac");
      await supabase.runInit({ build });
      break;
    }
    case "cloudflare": {
      const cloudflare = await import("@hot-updater/cloudflare/iac");
      await cloudflare.runInit({ build });
      break;
    }
    case "aws": {
      const aws = await import("@hot-updater/aws/iac");
      await aws.runInit({ build });
      break;
    }
    case "firebase": {
      const firebase = await import("@hot-updater/firebase/iac");
      await firebase.runInit({ build });
      break;
    }
    default:
      throw new Error("Invalid provider");
  }

  if (
    appendToProjectRootGitignore({
      globLines: [
        ".env.hotupdater",
        HotUpdateDirUtil.outputGitignorePath,
        HotUpdateDirUtil.logGitignorePath,
      ],
    })
  ) {
    p.log.info(".gitignore has been modified to include hot-updater entries");
  }
};
