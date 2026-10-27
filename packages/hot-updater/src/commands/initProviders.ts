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

/** A value init saved in `.env.hotupdater`, or the environment's. */
type SavedInput = (envKey: string) => string | undefined;

/** `postgres/<host>:<port>/<database>`, as `postgres()` marks its target. */
const postgresTarget = (url: string | undefined) => {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    return `postgres/${parsed.hostname}:${parsed.port || "5432"}/${decodeURIComponent(parsed.pathname.slice(1))}`;
  } catch {
    return undefined;
  }
};

/** `<prefix>/<value>`, or undefined without the value. */
const targetOf = (prefix: string, value: string | undefined) =>
  value === undefined ? undefined : `${prefix}/${value}`;

type InitProviderPackage = {
  /**
   * The `name` of the database the provider's init writes into
   * hot-updater.config.ts: doctor reads a config whose database has it, in a
   * project whose `.env.hotupdater` records this provider, as the deployment
   * init manages.
   */
  readonly database: string;
  /**
   * The target, under `Symbol.for("@hot-updater/database-target")`, of the
   * database init's saved inputs describe; undefined when they don't say.
   * Doctor names init only for a configured database with this target.
   */
  readonly target: (read: SavedInput) => string | undefined;
  readonly devDependencies: readonly string[];
  /** The provider in init's prompt: its package's `initProvider.label`. */
  readonly label: string;
  /**
   * The provider package's `./init`, the provider's whole init. Init imports
   * it once it has installed the package, which the CLI doesn't depend on.
   */
  readonly load: () => Promise<InitProviderModule>;
  readonly packageName: string;
  /** What init deploys and reconciles beside the database, for doctor's output. */
  readonly server: string;
};

export const INIT_PROVIDER_PACKAGES = {
  cloudflare: {
    database: "d1Database",
    target: (read) =>
      targetOf("d1", read("HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID")),
    devDependencies: ["wrangler"],
    label: "Cloudflare D1 + R2 + Worker",
    load: (): Promise<InitProviderModule> =>
      import("@hot-updater/cloudflare/init"),
    packageName: "@hot-updater/cloudflare",
    server: "the Worker",
  },
  aws: {
    database: "dynamoDB",
    target: (read) =>
      targetOf("dynamodb", read("HOT_UPDATER_DYNAMODB_TABLE_NAME")),
    devDependencies: [],
    label: "AWS + Lambda@Edge",
    load: (): Promise<InitProviderModule> => import("@hot-updater/aws/init"),
    packageName: "@hot-updater/aws",
    server: "the Lambda@Edge function and its IAM role policy",
  },
  supabase: {
    database: "supabaseDatabase",
    target: (read) => {
      const url = read("HOT_UPDATER_SUPABASE_URL");
      const projectId = read("HOT_UPDATER_SUPABASE_PROJECT_ID");
      try {
        return url !== undefined
          ? `supabase/${new URL(url).hostname}`
          : targetOf("supabase", projectId && `${projectId}.supabase.co`);
      } catch {
        return undefined;
      }
    },
    devDependencies: [],
    label: "Supabase",
    load: (): Promise<InitProviderModule> =>
      import("@hot-updater/supabase/init"),
    packageName: "@hot-updater/supabase",
    server: "the Edge Function",
  },
  firebase: {
    database: "firebaseDatabase",
    target: (read) =>
      targetOf(
        "firestore",
        read("HOT_UPDATER_FIREBASE_PROJECT_ID") &&
          `${read("HOT_UPDATER_FIREBASE_PROJECT_ID")}/${read("HOT_UPDATER_FIREBASE_DATABASE_ID") ?? "(default)"}`,
      ),
    devDependencies: ["firebase-tools", "firebase-admin"],
    label: "Firebase",
    load: (): Promise<InitProviderModule> =>
      import("@hot-updater/firebase/init"),
    packageName: "@hot-updater/firebase",
    server: "the Cloud Function",
  },
  vercel: {
    database: "postgres",
    target: (read) => postgresTarget(read("HOT_UPDATER_VERCEL_DATABASE_URL")),
    devDependencies: ["vercel"],
    label: "Vercel Blob + Functions + Postgres",
    load: (): Promise<InitProviderModule> => import("@hot-updater/vercel/init"),
    packageName: "@hot-updater/vercel",
    server: "the Vercel Function",
  },
  azure: {
    database: "cosmosDatabase",
    target: (read) =>
      targetOf(
        "cosmos",
        read("HOT_UPDATER_AZURE_COSMOS_ACCOUNT") &&
          `${read("HOT_UPDATER_AZURE_COSMOS_ACCOUNT")}.documents.azure.com`,
      ),
    devDependencies: [],
    label: "Azure Blob Storage + Functions + Cosmos DB",
    load: (): Promise<InitProviderModule> => import("@hot-updater/azure/init"),
    packageName: "@hot-updater/azure",
    server: "the Function App",
  },
} as const satisfies Record<string, InitProviderPackage>;

export type InitProvider = keyof typeof INIT_PROVIDER_PACKAGES;

/** Init saves the build adapter and provider it ran in `.env.hotupdater`, for replay. */
export const INIT_BUILD_ENV_KEY = "HOT_UPDATER_INIT_BUILD";
export const INIT_PROVIDER_ENV_KEY = "HOT_UPDATER_INIT_PROVIDER";

/** Init again with the inputs it saved: what reconciles a managed deployment. */
export const initReplayCommand = (provider: InitProvider) =>
  `npx hot-updater init --provider ${provider} --from-env-file .env.hotupdater`;

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
