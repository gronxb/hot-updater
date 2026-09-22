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
): Promise<{ build: string; provider: InitProvider }> => {
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

  const integrationModule = (await import(
    `${integrationPackage}/integration`
  )) as { initIntegration?: unknown };
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
    const providerModule = await providerPackage.load();
    await providerModule.runInit(runInitOptions);
  } catch (error) {
    if (handleInitError(error)) {
      return;
    }
    throw error;
  }
};
