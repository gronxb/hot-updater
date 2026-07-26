import type {
  BuildType,
  InitProvider,
  RunInitOptions,
} from "@hot-updater/cli-tools";
import {
  getHotUpdaterEnvValue,
  getMissingInitInputs,
  getMissingInitProviderInputs,
  HotUpdateDirUtil,
  INIT_PROVIDER_DEFINITIONS,
  INIT_PROVIDER_NAMES,
  InitError,
  isInitProvider,
  makeEnv,
  MissingInitInputsError,
  p,
  readHotUpdaterInitEnv,
  resolveInitProviderInputs,
} from "@hot-updater/cli-tools";
import { ExecaError } from "execa";

import { ensureInstallPackages } from "@/utils/ensureInstallPackages";
import {
  appendToProjectRootGitignore,
  isProjectFileTracked,
} from "@/utils/git";
import { printBanner } from "@/utils/printBanner";

const INIT_BUILD_ENV_KEY = "HOT_UPDATER_INIT_BUILD";
const INIT_PROVIDER_ENV_KEY = "HOT_UPDATER_INIT_PROVIDER";
const BUILD_PLUGIN_KEYS = ["bare", "rock", "expo"] as const;

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

type InitProviderModule = {
  runInit(options: RunInitOptions): Promise<void>;
};

const PROVIDERS = {
  supabase: {
    dependencies: [],
    devDependencies: ["@hot-updater/supabase"],
    load: (): Promise<InitProviderModule> =>
      import("@hot-updater/supabase/iac"),
  },
  aws: {
    dependencies: [],
    devDependencies: ["@hot-updater/aws"],
    load: (): Promise<InitProviderModule> => import("@hot-updater/aws/iac"),
  },
  cloudflare: {
    dependencies: [],
    devDependencies: ["wrangler", "@hot-updater/cloudflare"],
    load: (): Promise<InitProviderModule> =>
      import("@hot-updater/cloudflare/iac"),
  },
  firebase: {
    dependencies: [],
    devDependencies: [
      "firebase-tools",
      "firebase-admin",
      "@hot-updater/firebase",
    ],
    load: (): Promise<InitProviderModule> =>
      import("@hot-updater/firebase/iac"),
  },
} satisfies Record<
  InitProvider,
  {
    readonly dependencies: readonly string[];
    readonly devDependencies: readonly string[];
    readonly load: () => Promise<InitProviderModule>;
  }
>;

type BuildPluginKey = keyof typeof BUILD_PLUGINS;

export interface InitOptions {
  readonly build?: BuildPluginKey;
  readonly envFile?: string;
  readonly provider?: InitProvider;
}

const isBuildPluginKey = (
  value: string | undefined,
): value is BuildPluginKey => {
  return value === "bare" || value === "rock" || value === "expo";
};

const collectInitChoices = async (
  options: InitOptions,
): Promise<{ build: BuildPluginKey; provider: InitProvider }> => {
  const { env: existingEnv } = await readHotUpdaterInitEnv(
    process.cwd(),
    options.envFile,
  );
  const savedBuild = getHotUpdaterEnvValue(existingEnv, INIT_BUILD_ENV_KEY);
  const savedProvider = getHotUpdaterEnvValue(
    existingEnv,
    INIT_PROVIDER_ENV_KEY,
  );
  const build =
    options.build ?? (isBuildPluginKey(savedBuild) ? savedBuild : null);
  const provider =
    options.provider ?? (isInitProvider(savedProvider) ? savedProvider : null);

  if (options.envFile !== undefined) {
    const missingInputs = [
      ...getMissingInitInputs({
        [INIT_BUILD_ENV_KEY]: build ?? undefined,
        [INIT_PROVIDER_ENV_KEY]: provider ?? undefined,
      }),
      ...(provider
        ? getMissingInitProviderInputs({
            inputs: resolveInitProviderInputs(
              existingEnv,
              INIT_PROVIDER_DEFINITIONS[provider],
            ),
            provider: INIT_PROVIDER_DEFINITIONS[provider],
          })
        : []),
    ];
    if (missingInputs.length > 0) {
      throw new MissingInitInputsError([...new Set(missingInputs)]);
    }
  }

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
          : p.select<InitProvider>({
              message: "Select a provider",
              options: INIT_PROVIDER_NAMES.map((value) => ({
                value,
                label: INIT_PROVIDER_DEFINITIONS[value].label,
              })),
            }),
    },
    {
      onCancel: () => process.exit(0),
    },
  );

  return choices;
};

const handleInitError = (error: unknown): boolean => {
  if (!(error instanceof InitError)) {
    return false;
  }

  p.log.error(error.message);
  process.exitCode = 1;
  return true;
};

export const init = async (options: InitOptions = {}) => {
  printBanner();

  let choices: Awaited<ReturnType<typeof collectInitChoices>>;
  try {
    choices = await collectInitChoices(options);
  } catch (error) {
    if (handleInitError(error)) {
      return;
    }
    throw error;
  }

  if (
    isProjectFileTracked({
      cwd: process.cwd(),
      filePath: ".env.hotupdater",
    })
  ) {
    p.log.error(
      "Refusing to save init credentials because .env.hotupdater is tracked by Git. Untrack it before running init.",
    );
    process.exitCode = 1;
    return;
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
        ...PROVIDERS[provider].dependencies,
      ],
      devDependencies: [
        ...buildPluginPackage.devDependencies,
        ...REQUIRED_PACKAGES.devDependencies,
        ...PROVIDERS[provider].devDependencies,
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
  const runInitOptions = {
    build,
    envFile: options.envFile,
  } satisfies RunInitOptions;
  try {
    const providerModule = await PROVIDERS[provider].load();
    await providerModule.runInit(runInitOptions);
  } catch (error) {
    if (handleInitError(error)) {
      return;
    }
    throw error;
  }
};
