import path from "node:path";

import {
  assertInitIntegrationDescriptor,
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
  type RunInitOptions,
} from "@hot-updater/cli-tools";
import { ExecaError } from "execa";
import { createJiti } from "jiti";

import { ensureInstallPackages } from "@/utils/ensureInstallPackages";
import {
  appendToProjectRootGitignore,
  isProjectFileTracked,
} from "@/utils/git";
import { printBanner } from "@/utils/printBanner";

import {
  assertInstalledInitProvider,
  INIT_PROVIDER_NAMES,
  INIT_PROVIDER_PACKAGES,
  type InitProvider,
  isInitProvider,
  loadInitProvider,
} from "./initProviders";

const INIT_BUILD_ENV_KEY = "HOT_UPDATER_INIT_BUILD";
const INIT_PROVIDER_ENV_KEY = "HOT_UPDATER_INIT_PROVIDER";
export interface InitOptions {
  readonly build?: string;
  readonly envFile?: string;
  readonly provider?: InitProvider;
}

const isIntegrationName = (value: string | undefined): value is string =>
  value !== undefined &&
  /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/.test(
    value,
  );

export const integrationPackageName = (value: string): string =>
  value.startsWith("@") ? value : `@hot-updater/${value}`;

const collectInitChoices = async (
  options: InitOptions,
): Promise<{
  build: string;
  env: Readonly<Record<string, string>>;
  provider: InitProvider;
}> => {
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
    options.build ?? (isIntegrationName(savedBuild) ? savedBuild : null);
  const provider =
    options.provider ?? (isInitProvider(savedProvider) ? savedProvider : null);

  // The provider's own inputs are checked once its package is installed.
  if (options.envFile !== undefined) {
    const missingInputs = getMissingInitInputs({
      [INIT_BUILD_ENV_KEY]: build ?? undefined,
      [INIT_PROVIDER_ENV_KEY]: provider ?? undefined,
    });
    if (missingInputs.length > 0) {
      throw new MissingInitInputsError(missingInputs);
    }
  }

  if (build && provider) {
    return { build, env: existingEnv, provider };
  }

  const choices = await p.group(
    {
      build: () =>
        build
          ? Promise.resolve(build)
          : p.text({
              message: "Enter an application integration package or short name",
              placeholder: "@hot-updater/<integration>",
              validate: (value) =>
                isIntegrationName(value)
                  ? undefined
                  : "Use a package name or an unscoped short name.",
            }),
      provider: () =>
        provider
          ? Promise.resolve(provider)
          : p.select<InitProvider>({
              message: "Select a provider",
              options: INIT_PROVIDER_NAMES.map((value) => ({
                value,
                label: INIT_PROVIDER_PACKAGES[value].label,
              })),
            }),
    },
    {
      onCancel: () => process.exit(0),
    },
  );

  return { ...choices, env: existingEnv };
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
    // A provider package the project already has must match this CLI.
    await assertInstalledInitProvider(choices.provider);
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

  const integrationPackage = integrationPackageName(choices.build);
  const provider = choices.provider;
  const providerPackage = INIT_PROVIDER_PACKAGES[provider];

  await makeEnv({
    [INIT_BUILD_ENV_KEY]: choices.build,
    [INIT_PROVIDER_ENV_KEY]: provider,
  });

  try {
    await ensureInstallPackages({
      dependencies: [],
      devDependencies: [
        integrationPackage,
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

  // Resolve the installed adapter from the app, including ESM-only adapters.
  const loader = createJiti(path.join(process.cwd(), "package.json"));
  const integrationModule = await loader.import<{ initIntegration?: unknown }>(
    `${integrationPackage}/integration`,
  );
  assertInitIntegrationDescriptor(integrationModule.initIntegration);
  const integration = integrationModule.initIntegration;
  await ensureInstallPackages({
    dependencies: [...integration.dependencies],
    devDependencies: [...integration.devDependencies],
  });
  await integration.prepare?.({
    cwd: process.cwd(),
    envFile: options.envFile,
  });
  const build = integration.build;
  const runInitOptions = {
    build,
    envFile: options.envFile,
  } satisfies RunInitOptions;
  try {
    const { initProvider, runInit } = await loadInitProvider(provider);
    if (options.envFile !== undefined) {
      // Before any cloud resource changes, every missing input at once.
      const missingInputs = getMissingInitProviderInputs({
        inputs: resolveInitProviderInputs(choices.env, initProvider),
        preflightOnly: true,
        provider: initProvider,
      });
      if (missingInputs.length > 0) {
        throw new MissingInitInputsError([...new Set(missingInputs)]);
      }
    }
    await runInit(runInitOptions);
  } catch (error) {
    if (handleInitError(error)) {
      return;
    }
    throw error;
  }
};
