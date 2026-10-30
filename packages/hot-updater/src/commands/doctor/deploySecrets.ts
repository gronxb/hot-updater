import fs from "node:fs/promises";
import path from "node:path";

import {
  type ConfigResponse,
  getConfiguredAdapter,
  getHotUpdaterEnvValue,
  getDeploySecretNames,
  readLoadedHotUpdaterEnv,
  secretVariableName,
} from "@hot-updater/cli-tools";

import { ui } from "../../utils/cli-ui";
import type { ManagedDeployment } from "./managed";
import type { ScaffoldDeployment } from "./scaffoldRecords";
import { listNames, type SecretsIssue } from "./secrets";

/** Where a command reads one name an adapter's `secret()` reads. */
export interface DeploySecretStatus {
  readonly name: string;
  /**
   * `environment`: the environment or `.env.hotupdater` sets it, which wins;
   * `adapter`: the team `secrets` adapter holds it; `missing`: neither.
   * Undefined when the adapter can't be read.
   */
  readonly source?: "environment" | "adapter" | "missing";
  /** Whether the adapter holds it too; undefined without one, or when it can't be read. */
  readonly inAdapter?: boolean;
}

export interface DeploySecretsStatus {
  /** The team `secrets` adapter's name; undefined with `localSecrets()`. */
  readonly adapter?: string;
  readonly names: readonly DeploySecretStatus[];
  /** Why the adapter couldn't be read. */
  readonly error?: string;
  /** The warnings: a name that is neither set nor in the adapter. */
  readonly issues: readonly SecretsIssue[];
  /**
   * The managed credentials hot-updater.config.ts reads as
   * `process.env.<name>`, which no adapter supplies.
   */
  readonly processEnvReads: readonly string[];
  /**
   * Init's command, which rewrites `processEnvReads` to `secret()`, for a
   * deployment init manages; undefined otherwise, such as one an agent
   * infrastructure scaffold keeps, where the config is edited instead.
   */
  readonly initCommand?: string;
}

/** Where `secret()` for adapters is documented, for an edit by hand. */
export const DEPLOY_SECRETS_DOCS_URL =
  "https://hot-updater.dev/docs/concepts/secrets#adapter-credentials";

/**
 * Init's command when running init again may rewrite the config: the
 * deployment is init's, the configured database the one it saved, with only
 * the official plugins, and no agent infrastructure scaffold records a
 * deployment of its provider, which init would replace. Undefined otherwise.
 */
export const deploySecretsInitCommand = ({
  managed,
  scaffolds,
}: {
  readonly managed: Pick<
    ManagedDeployment,
    "provider" | "command" | "confirmed" | "foreignPlugins"
  > | null;
  readonly scaffolds: readonly Pick<ScaffoldDeployment, "provider">[];
}): string | undefined =>
  managed !== null &&
  managed.confirmed &&
  managed.foreignPlugins.length === 0 &&
  !scaffolds.some(({ provider }) => provider === managed.provider)
    ? managed.command
    : undefined;

/**
 * What moves the managed credentials the config reads with `process.env` to
 * `secret()`: init's command when init manages the deployment, else an
 * edit of the config, as the docs show.
 */
export const deploySecretsAdvice = (
  them: "it" | "them",
  initCommand: string | undefined,
): string[] =>
  initCommand === undefined
    ? [
        `Read ${them} with secret() in hot-updater.config.ts:`,
        ui.path(DEPLOY_SECRETS_DOCS_URL),
      ]
    : [
        `Run init again to read ${them} with secret():`,
        ui.commandLines(initCommand),
      ];

/**
 * Where each name the config's adapter `secret()`s read comes from, with one `get`
 * of them all from the team adapter: nothing is written, and no value is
 * kept. With a team adapter, `managedSecrets`, the credentials the
 * provider's init saves, are also looked for as `process.env.<name>` in the
 * config's text; without one they are never asked for. Undefined when there
 * is nothing to report.
 */
export const checkDeploySecrets = async (
  config: ConfigResponse,
  {
    cwd,
    managedSecrets = async () => [],
  }: {
    readonly cwd: string;
    readonly managedSecrets?: () => Promise<readonly string[]>;
  },
): Promise<DeploySecretsStatus | undefined> => {
  const adapter = getConfiguredAdapter(config.secrets);
  const processEnvReads =
    adapter === undefined
      ? []
      : await readProcessEnvReads(cwd, await managedSecrets());
  const names = getDeploySecretNames(config);
  if (names.length === 0 && processEnvReads.length === 0) return undefined;

  const env = await readLoadedHotUpdaterEnv(cwd);
  let held: Readonly<Record<string, string | undefined>> | undefined;
  let error: string | undefined;
  if (adapter !== undefined && names.length > 0) {
    try {
      held = await adapter.get(names, { cwd });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  const statuses = names.map((name): DeploySecretStatus => {
    const environment =
      getHotUpdaterEnvValue(env, secretVariableName(name)) !== undefined;
    if (adapter === undefined) {
      return { name, source: environment ? "environment" : "missing" };
    }
    if (held === undefined) {
      return environment ? { name, source: "environment" } : { name };
    }
    const value = Object.hasOwn(held, name) ? held[name] : undefined;
    const inAdapter = typeof value === "string" && value.length > 0;
    return {
      name,
      source: environment ? "environment" : inAdapter ? "adapter" : "missing",
      inAdapter,
    };
  });
  const missing = statuses
    .filter(({ source }) => source === "missing")
    .map(({ name }) => name);
  const one = missing.length === 1;

  return {
    ...(adapter === undefined ? {} : { adapter: adapter.name }),
    names: statuses,
    ...(error === undefined ? {} : { error }),
    issues:
      missing.length === 0
        ? []
        : [
            {
              type: "warning",
              code: "DEPLOY_SECRETS_MISSING",
              names: missing,
              message: `${listNames(missing)} ${one ? "is" : "are"} missing: a deploy reads ${one ? "it" : "them"} with secret().`,
              resolution:
                adapter === undefined
                  ? `Set ${one ? "it" : "them"} in the environment or .env.hotupdater.`
                  : `Store ${one ? "it" : "them"} in the ${adapter.name} secrets adapter, or set ${one ? "it" : "them"} in the environment or .env.hotupdater.`,
            },
          ],
    processEnvReads,
  };
};

const readProcessEnvReads = async (
  cwd: string,
  names: readonly string[],
): Promise<string[]> => {
  if (names.length === 0) return [];
  const text = await fs
    .readFile(path.join(cwd, "hot-updater.config.ts"), "utf8")
    .catch(() => "");
  return names.filter((name) =>
    new RegExp(`process\\.env\\.${name}\\b`, "u").test(text),
  );
};
