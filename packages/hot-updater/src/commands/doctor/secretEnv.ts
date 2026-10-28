import fs from "node:fs/promises";
import path from "node:path";

import {
  type ConfigResponse,
  getConfiguredAdapter,
  getHotUpdaterEnvValue,
  getSecretEnvNames,
  readLoadedHotUpdaterEnv,
} from "@hot-updater/cli-tools";

import { ui } from "../../utils/cli-ui";
import type { ManagedDeployment } from "./managed";
import type { ScaffoldDeployment } from "./scaffoldRecords";

/** Where a command reads one name the config's `secretEnv` reads. */
export interface SecretEnvNameStatus {
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

export interface SecretEnvStatus {
  /** The team `secrets` adapter's name; undefined with `localSecrets()`. */
  readonly adapter?: string;
  readonly names: readonly SecretEnvNameStatus[];
  /** Why the adapter couldn't be read. */
  readonly error?: string;
  /**
   * The managed credentials hot-updater.config.ts reads as
   * `process.env.<name>`, which no adapter supplies.
   */
  readonly processEnvReads: readonly string[];
  /**
   * Init's command, which rewrites `processEnvReads` to `secretEnv`, for a
   * deployment init manages; undefined otherwise, such as one an agent
   * infrastructure scaffold keeps, where the config is edited instead.
   */
  readonly initCommand?: string;
}

/** Where the config's `secretEnv` is documented, for an edit by hand. */
export const SECRET_ENV_DOCS_URL =
  "https://hot-updater.dev/docs/concepts/secrets#deploy-credentials-with-secretenv";

/**
 * Init's command when running init again may rewrite the config: the
 * deployment is init's, the configured database the one it saved, with only
 * the official plugins, and no agent infrastructure scaffold records a
 * deployment of its provider, which init would replace. Undefined otherwise.
 */
export const secretEnvInitCommand = ({
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
 * `secretEnv`: init's command when init manages the deployment, else an
 * edit of the config, as the docs show.
 */
export const secretEnvAdvice = (
  them: "it" | "them",
  initCommand: string | undefined,
): string[] =>
  initCommand === undefined
    ? [
        `Read ${them} with secretEnv in hot-updater.config.ts:`,
        ui.path(SECRET_ENV_DOCS_URL),
      ]
    : [
        `Run init again to read ${them} with secretEnv:`,
        ui.commandLines(initCommand),
      ];

/**
 * Where each name the config's `secretEnv` reads comes from, with one `get`
 * of them all from the team adapter: nothing is written, and no value is
 * kept. With a team adapter, `managedSecrets`, the credentials the
 * provider's init saves, are also looked for as `process.env.<name>` in the
 * config's text; without one they are never asked for. Undefined when there
 * is nothing to report.
 */
export const checkSecretEnv = async (
  config: ConfigResponse,
  {
    cwd,
    managedSecrets = async () => [],
  }: {
    readonly cwd: string;
    readonly managedSecrets?: () => Promise<readonly string[]>;
  },
): Promise<SecretEnvStatus | undefined> => {
  const adapter = getConfiguredAdapter(config.secrets);
  const processEnvReads =
    adapter === undefined
      ? []
      : await readProcessEnvReads(cwd, await managedSecrets());
  const names = getSecretEnvNames(config);
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

  return {
    ...(adapter === undefined ? {} : { adapter: adapter.name }),
    names: names.map((name): SecretEnvNameStatus => {
      const environment = getHotUpdaterEnvValue(env, name) !== undefined;
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
    }),
    ...(error === undefined ? {} : { error }),
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
