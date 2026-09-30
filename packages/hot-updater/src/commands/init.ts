import type { BuildType, RunInitOptions } from "@hot-updater/cli-tools";
import {
  getHotUpdaterEnvValue,
  getMissingInitInputs,
  getMissingInitProviderInputs,
  HotUpdateDirUtil,
  InitError,
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

import {
  type InitProvider,
  INIT_PROVIDER_NAMES,
  INIT_PROVIDER_PACKAGES,
  isInitProvider,
} from "./initProviders";

const INIT_BUILD_ENV_KEY = "HOT_UPDATER_INIT_BUILD";
const INIT_PROVIDER_ENV_KEY = "HOT_UPDATER_INIT_PROVIDER";
const BUILD_ADAPTER_KEYS = ["bare", "rock", "expo"] as const;

const REQUIRED_PACKAGES = {
  dependencies: ["@hot-updater/react-native"],
};

interface BuildAdapterChoice {
  name: BuildType;
  label: string;
  hint?: string;
  dependencies: string[];
  devDependencies: string[];
}

const BUILD_ADAPTERS: Record<"bare" | "rock" | "expo", BuildAdapterChoice> = {
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

type BuildAdapterKey = keyof typeof BUILD_ADAPTERS;

export interface InitOptions {
  readonly build?: BuildAdapterKey;
  readonly envFile?: string;
  readonly provider?: InitProvider;
}

const isBuildAdapterKey = (
  value: string | undefined,
): value is BuildAdapterKey => {
  return value !== undefined && Object.keys(BUILD_ADAPTERS).includes(value);
};

const collectInitChoices = async (
  options: InitOptions,
): Promise<{ build: BuildAdapterKey; provider: InitProvider }> => {
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
    options.build ?? (isBuildAdapterKey(savedBuild) ? savedBuild : null);
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
              INIT_PROVIDER_PACKAGES[provider].definition,
            ),
            preflightOnly: true,
            provider: INIT_PROVIDER_PACKAGES[provider].definition,
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
          : p.select<BuildAdapterKey>({
              message: "Select a build adapter",
              options: BUILD_ADAPTER_KEYS.map((value) => ({
                value,
                label: BUILD_ADAPTERS[value].label,
                hint: BUILD_ADAPTERS[value].hint,
              })),
            }),
      provider: () =>
        provider
          ? Promise.resolve(provider)
          : p.select<InitProvider>({
              message: "Select a provider",
              options: INIT_PROVIDER_NAMES.map((value) => ({
                value,
                label: INIT_PROVIDER_PACKAGES[value].definition.label,
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

  const buildAdapterPackage = BUILD_ADAPTERS[choices.build];
  const provider = choices.provider;
  const providerPackage = INIT_PROVIDER_PACKAGES[provider];

  await makeEnv({
    [INIT_BUILD_ENV_KEY]: choices.build,
    [INIT_PROVIDER_ENV_KEY]: provider,
  });

  try {
    await ensureInstallPackages({
      dependencies: [
        ...buildAdapterPackage.dependencies,
        ...REQUIRED_PACKAGES.dependencies,
      ],
      devDependencies: [
        ...buildAdapterPackage.devDependencies,
        ...providerPackage.devDependencies,
        providerPackage.packageName,
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

  const build = buildAdapterPackage.name;
  const runInitOptions = {
    build,
    envFile: options.envFile,
  } satisfies RunInitOptions;
  try {
    const providerModule = await providerPackage.load();
    await providerModule.runInit(runInitOptions);
  } catch (error) {
    if (handleInitError(error)) {
      return;
    }
    throw error;
  }
};
