import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { INFRA_BUILDS } from "../infra/scaffold";
import {
  INIT_PROVIDER_NAMES,
  INIT_PROVIDER_PACKAGES,
  type InitProvider,
} from "../initProviders";
import { isObject } from "./checks";

/** Where `agent infra setup|upgrade` writes a scaffold unless given `--output`. */
const SCAFFOLD_ROOT = "hot-updater-infra";

/**
 * The init inputs each provider's scaffold resources stand for, by resource:
 * what gives the database target, as `INIT_PROVIDER_PACKAGES[provider].target`
 * derives it. Vercel's record names no database, so its target is unknown.
 */
const TARGET_RESOURCES: Record<InitProvider, Record<string, string>> = {
  cloudflare: { HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID: "d1DatabaseId" },
  supabase: { HOT_UPDATER_SUPABASE_PROJECT_ID: "projectId" },
  aws: { HOT_UPDATER_DYNAMODB_TABLE_NAME: "tableName" },
  firebase: {
    HOT_UPDATER_FIREBASE_PROJECT_ID: "projectId",
    HOT_UPDATER_FIREBASE_DATABASE_ID: "databaseId",
  },
  vercel: {},
  azure: { HOT_UPDATER_AZURE_COSMOS_ACCOUNT: "cosmosAccount" },
};

/** The database target a deployment record's resources describe, if they say. */
const targetOf = (
  provider: InitProvider,
  resources: unknown,
): string | undefined => {
  if (!isObject(resources)) return undefined;
  return INIT_PROVIDER_PACKAGES[provider].target((envKey) => {
    const resource = TARGET_RESOURCES[provider][envKey];
    const value = resource === undefined ? undefined : resources[resource];
    return typeof value === "string" && value ? value : undefined;
  });
};

/** A deployment an agent infrastructure scaffold records. */
export interface ScaffoldDeployment {
  /** The scaffold directory, relative to the project. */
  readonly dir: string;
  readonly provider: InitProvider;
  readonly build: (typeof INFRA_BUILDS)[number];
  /** The server's base URL deployment.json records; null before a deploy. */
  readonly baseUrl: string | null;
  /** The database target its resources describe, as the database marks it. */
  readonly target: string | undefined;
}

const readJson = async (file: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
};

/**
 * The deployments the agent infrastructure scaffolds in the CLI's default
 * output, `hot-updater-infra/<provider>/*`, record: a setup or upgrade
 * manifest beside a deployment.json with no pending step. A scaffold written
 * elsewhere with `--output` is not found; doctor verifies it with
 * `--scope infrastructure --infra-dir <dir>`.
 */
export const findScaffoldDeployments = async (
  cwd: string,
): Promise<ScaffoldDeployment[]> => {
  const root = path.join(cwd, SCAFFOLD_ROOT);
  const found: ScaffoldDeployment[] = [];
  const providers: string[] = await readdir(root).catch(() => []);
  for (const provider of INIT_PROVIDER_NAMES) {
    if (!providers.includes(provider)) continue;
    const dirs: string[] = await readdir(path.join(root, provider)).catch(
      () => [],
    );
    for (const name of dirs.sort()) {
      const dir = path.join(root, provider, name);
      const manifest = await readJson(path.join(dir, "manifest.json"));
      const record = await readJson(path.join(dir, "deployment.json"));
      if (
        !isObject(manifest) ||
        manifest["schemaVersion"] !== 1 ||
        manifest["provider"] !== provider ||
        (manifest["operation"] !== "setup" &&
          manifest["operation"] !== "upgrade") ||
        !INFRA_BUILDS.some((build) => build === manifest["build"]) ||
        !isObject(record) ||
        record["schemaVersion"] !== 1 ||
        record["provider"] !== provider ||
        record["pendingStep"] !== null
      ) {
        continue;
      }
      const baseUrl = record["baseUrl"];
      found.push({
        dir: path.relative(cwd, dir),
        provider,
        build: manifest["build"] as ScaffoldDeployment["build"],
        baseUrl: typeof baseUrl === "string" && baseUrl ? baseUrl : null,
        target: targetOf(provider, record["resources"]),
      });
    }
  }
  return found;
};

/** The distinct servers `deployments` record, by base URL. */
export const recordedBaseUrls = (
  deployments: readonly ScaffoldDeployment[],
): string[] => [
  ...new Set(
    deployments.flatMap(({ baseUrl }) =>
      baseUrl === null ? [] : [baseUrl.replace(/\/+$/u, "")],
    ),
  ),
];

/** What upgrades a deployment its agent infrastructure scaffold keeps. */
export interface ScaffoldUpgrade {
  /** The scaffold directories that record the provider's deployments. */
  readonly dirs: readonly string[];
  /** Null when they record more than one deployment: doctor cannot pick. */
  readonly command: string | null;
}

/**
 * The scaffold upgrade for `provider`'s deployment, when the default
 * scaffold output records one it deployed, a server's base URL, on the
 * configured database. A scaffold generated but not deployed records no
 * base URL, and one of another database is not this deployment.
 */
export const scaffoldUpgradeFor = (
  deployments: readonly ScaffoldDeployment[],
  provider: InitProvider,
  /** The configured database's target: a scaffold keeps it only if it records the same. */
  target: string | undefined,
): ScaffoldUpgrade | null => {
  if (target === undefined) return null;
  const matches = deployments.filter(
    (record) =>
      record.provider === provider &&
      record.baseUrl !== null &&
      record.target === target,
  );
  if (matches.length === 0) return null;
  // Directory names say nothing about which build is current, so the build
  // is named only when every record agrees on it.
  const builds = [...new Set(matches.map(({ build }) => build))];
  return {
    dirs: matches.map(({ dir }) => dir),
    command:
      recordedBaseUrls(matches).length > 1
        ? null
        : `npx hot-updater agent infra upgrade --provider ${provider} --build ${builds.length === 1 ? builds[0] : "<build>"}`,
  };
};

/** How to upgrade through the scaffold, and in which order. */
export const scaffoldUpgradeNote = ({ dirs, command }: ScaffoldUpgrade) =>
  command === null
    ? `The agent infrastructure scaffolds in ${dirs.join(", ")} record more than one deployment: upgrade the one this database belongs to with \`npx hot-updater agent infra upgrade\`, and apply it as its upgrades/README.md says: upload the new server version and preview it, then migrate the database and deploy that version back to back.`
    : `This deployment is kept with the agent infrastructure ${dirs.length === 1 ? "scaffold" : "scaffolds"} in ${dirs.join(", ")}: run \`${command}\`, and apply the new scaffold as its upgrades/README.md says: upload the new server version and preview it, then migrate the database and deploy that version back to back. Running init again instead would deploy at once, without that preview, and leave the scaffold behind.`;
