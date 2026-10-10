import { createRequire } from "node:module";

import {
  type InitProviderDefinition,
  InitError,
  type RunInitOptions,
} from "@hot-updater/cli-tools";

import { packageJsonData } from "../packageJson";

/** What a provider package's `./init` entry exports. */
export type InitProviderModule = {
  readonly initProvider: InitProviderDefinition;
  readonly runInit: (options: RunInitOptions) => Promise<void>;
};

type InitProviderPackage = {
  readonly devDependencies: readonly string[];
  /** The provider in init's prompt: its package's `initProvider.label`. */
  readonly label: string;
  /**
   * The provider package's `./init`, the provider's whole init. Init imports
   * it once it has installed the package, which the CLI doesn't depend on.
   */
  readonly load: () => Promise<InitProviderModule>;
  readonly packageName: string;
};

export const INIT_PROVIDER_PACKAGES = {
  cloudflare: {
    devDependencies: ["wrangler"],
    label: "Cloudflare D1 + R2 + Worker",
    load: (): Promise<InitProviderModule> =>
      import("@hot-updater/cloudflare/init"),
    packageName: "@hot-updater/cloudflare",
  },
  aws: {
    devDependencies: [],
    label: "AWS + Lambda@Edge",
    load: (): Promise<InitProviderModule> => import("@hot-updater/aws/init"),
    packageName: "@hot-updater/aws",
  },
  supabase: {
    devDependencies: [],
    label: "Supabase",
    load: (): Promise<InitProviderModule> =>
      import("@hot-updater/supabase/init"),
    packageName: "@hot-updater/supabase",
  },
  firebase: {
    devDependencies: ["firebase-tools", "firebase-admin"],
    label: "Firebase",
    load: (): Promise<InitProviderModule> =>
      import("@hot-updater/firebase/init"),
    packageName: "@hot-updater/firebase",
  },
} as const satisfies Record<string, InitProviderPackage>;

export type InitProvider = keyof typeof INIT_PROVIDER_PACKAGES;

export const isInitProvider = (
  value: string | undefined,
): value is InitProvider =>
  value !== undefined && Object.hasOwn(INIT_PROVIDER_PACKAGES, value);

export const INIT_PROVIDER_NAMES = Object.keys(INIT_PROVIDER_PACKAGES).filter(
  isInitProvider,
);

/** The version of `packageName` that `load` imports, if it resolves. */
const installedVersionOf = (packageName: string): string | undefined => {
  try {
    return (
      createRequire(import.meta.url)(`${packageName}/package.json`) as {
        readonly version?: string;
      }
    ).version;
  } catch {
    return undefined;
  }
};

const installHint = (packageName: string) =>
  `Install ${packageName}@${packageJsonData.version} to match hot-updater ${packageJsonData.version}, and run init again.`;

/** Whether a loaded `./init` is the whole init, as this CLI runs it. */
const isWholeInit = (
  entry: Partial<InitProviderModule>,
): entry is InitProviderModule =>
  typeof entry.runInit === "function" &&
  typeof entry.initProvider?.inputs === "object";

/** An `./init` without `runInit`: a provider package this CLI cannot run. */
const noInitError = (packageName: string) => {
  const installed = installedVersionOf(packageName);
  return new InitError(
    `${installed === undefined ? packageName : `${packageName}@${installed}`} has no init for hot-updater ${packageJsonData.version}: its ./init exports no runInit.\n${installHint(packageName)}`,
  );
};

/**
 * Before init edits a file: a provider package the project already has must
 * have this CLI's init, or init stops with the version to install. One that
 * fails to load is left to `loadInitProvider`, after init has installed what
 * the provider needs, such as Firebase's `firebase-admin`.
 */
export const assertInstalledInitProvider = async (
  provider: InitProvider,
): Promise<void> => {
  const { load, packageName } = INIT_PROVIDER_PACKAGES[provider];
  if (installedVersionOf(packageName) === undefined) return;
  const entry = await load().catch(() => undefined);
  if (entry !== undefined && !isWholeInit(entry)) {
    throw noInitError(packageName);
  }
};

/**
 * The provider package's init, which init imports once it has installed the
 * package and before it changes any resource. A package that fails to load,
 * such as for a missing peer, or whose `./init` has no `runInit`, stops init
 * with the version to install: hot-updater's own.
 */
export const loadInitProvider = async (
  provider: InitProvider,
): Promise<InitProviderModule> => {
  const { load, packageName } = INIT_PROVIDER_PACKAGES[provider];
  let entry: Partial<InitProviderModule>;
  try {
    entry = await load();
  } catch (error) {
    throw new InitError(
      `${packageName} failed to load: ${error instanceof Error ? error.message : String(error)}\n${installHint(packageName)}`,
    );
  }
  if (!isWholeInit(entry)) throw noInitError(packageName);
  return entry;
};
