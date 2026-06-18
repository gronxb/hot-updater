import type { BuildType } from "@hot-updater/cli-tools";
import { HotUpdateDirUtil, p } from "@hot-updater/cli-tools";
import { ExecaError } from "execa";

import { ensureInstallPackages } from "@/utils/ensureInstallPackages";
import { appendToProjectRootGitignore } from "@/utils/git";
import { printBanner } from "@/utils/printBanner";

const REQUIRED_PACKAGES = {
  dependencies: ["@hot-updater/react-native"],
  devDependencies: ["dotenv"],
};

interface BuildPluginChoice {
  name: string;
  label: string;
  hint?: string;
  dependencies: string[];
  devDependencies: string[];
}

const BUILD_PLUGINS: Record<"bare" | "rock" | "expo", BuildPluginChoice> = {
  bare: {
    name: "bare",
    label: "Bare",
    hint: "React Native CLI",
    dependencies: [],
    devDependencies: ["@hot-updater/bare"],
  },
  rock: {
    name: "rock",
    label: "Rock",
    hint: "React Native Enterprise Framework by Callstack",
    dependencies: [],
    devDependencies: ["@hot-updater/rock"],
  },
  expo: {
    name: "expo",
    label: "Expo",
    dependencies: [],
    devDependencies: ["@hot-updater/expo"],
  },
};

const PROVIDER_LABELS = {
  cloudflare: "Cloudflare D1 + R2 + Worker",
  aws: "AWS S3 + Lambda@Edge",
  supabase: "Supabase",
  firebase: "Firebase",
} as const;

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

type BuildPluginKey = keyof typeof BUILD_PLUGINS;
type Provider = keyof typeof PACKAGE_MAP;

export interface InitOptions {
  build?: BuildPluginKey;
  provider?: Provider;
}

const resolveBuildPlugin = async (flag?: BuildPluginKey) => {
  if (flag) {
    return BUILD_PLUGINS[flag];
  }

  const selected = await p.select<BuildPluginChoice>({
    message: "Select a build plugin",
    options: Object.values(BUILD_PLUGINS).map((plugin) => ({
      value: plugin,
      label: plugin.label,
      hint: plugin.hint,
    })),
  });

  if (p.isCancel(selected)) {
    process.exit(0);
  }

  return selected;
};

const resolveProvider = async (flag?: Provider): Promise<Provider> => {
  if (flag) {
    return flag;
  }

  const selected = await p.select<Provider>({
    message: "Select a provider",
    options: (Object.keys(PROVIDER_LABELS) as Provider[]).map((value) => ({
      value,
      label: PROVIDER_LABELS[value],
    })),
  });

  if (p.isCancel(selected)) {
    process.exit(0);
  }

  return selected;
};

export const init = async (options: InitOptions = {}) => {
  printBanner();

  const buildPluginPackage = await resolveBuildPlugin(options.build);
  const provider = await resolveProvider(options.provider);

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
