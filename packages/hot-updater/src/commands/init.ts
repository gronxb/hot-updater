import type { BuildType } from "@hot-updater/cli-tools";
import {
  getHotUpdaterEnvValue,
  HotUpdateDirUtil,
  makeEnv,
  p,
  readHotUpdaterEnv,
} from "@hot-updater/cli-tools";
import { ExecaError } from "execa";

import { ensureInstallPackages } from "@/utils/ensureInstallPackages";
import { appendToProjectRootGitignore } from "@/utils/git";
import { printBanner } from "@/utils/printBanner";

const INIT_BUILD_ENV_KEY = "HOT_UPDATER_INIT_BUILD";
const INIT_PROVIDER_ENV_KEY = "HOT_UPDATER_INIT_PROVIDER";
const BUILD_PLUGIN_KEYS = ["bare", "rock", "expo"] as const;
const PROVIDERS = ["cloudflare", "aws", "supabase", "firebase"] as const;

const REQUIRED_PACKAGES = {
  dependencies: ["@hot-updater/react-native"],
  devDependencies: ["dotenv"],
};

interface BuildPluginChoice {
  name: BuildType;
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

const isBuildPluginKey = (
  value: string | undefined,
): value is BuildPluginKey => {
  return value === "bare" || value === "rock" || value === "expo";
};

const isProvider = (value: string | undefined): value is Provider => {
  return (
    value === "cloudflare" ||
    value === "aws" ||
    value === "supabase" ||
    value === "firebase"
  );
};

const collectInitChoices = async (
  options: InitOptions,
): Promise<{ build: BuildPluginKey; provider: Provider }> => {
  const existingEnv = await readHotUpdaterEnv(process.cwd());
  const savedBuild = getHotUpdaterEnvValue(existingEnv, INIT_BUILD_ENV_KEY);
  const savedProvider = getHotUpdaterEnvValue(
    existingEnv,
    INIT_PROVIDER_ENV_KEY,
  );
  const build =
    options.build ?? (isBuildPluginKey(savedBuild) ? savedBuild : null);
  const provider =
    options.provider ?? (isProvider(savedProvider) ? savedProvider : null);

  if (build && provider) {
    return { build, provider };
  }

  const choices = await p.group(
    {
      build: () =>
        build
          ? Promise.resolve(build)
          : p.select<BuildPluginKey>({
              message: "Select a build plugin",
              options: BUILD_PLUGIN_KEYS.map((value) => ({
                value,
                label: BUILD_PLUGINS[value].label,
                hint: BUILD_PLUGINS[value].hint,
              })),
            }),
      provider: () =>
        provider
          ? Promise.resolve(provider)
          : p.select<Provider>({
              message: "Select a provider",
              options: PROVIDERS.map((value) => ({
                value,
                label: PROVIDER_LABELS[value],
              })),
            }),
    },
    {
      onCancel: () => process.exit(0),
    },
  );

  return choices;
};

export const init = async (options: InitOptions = {}) => {
  printBanner();

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

  const choices = await collectInitChoices(options);
  const buildPluginPackage = BUILD_PLUGINS[choices.build];
  const provider = choices.provider;

  await makeEnv({
    [INIT_BUILD_ENV_KEY]: choices.build,
    [INIT_PROVIDER_ENV_KEY]: provider,
  });

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

  const build = buildPluginPackage.name;
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
};
