import path from "node:path";

import { loadConfig, p } from "@hot-updater/cli-tools";
import type {
  ApiKeyManagementAPI,
  ApiKeyMetadata,
} from "@hot-updater/server/plugins/api-keys";

import { printBanner } from "@/utils/printBanner";

import { ui } from "../utils/cli-ui";
import { loadServer } from "../utils/loadServer";
import {
  findDefaultConfigPaths,
  loadHotUpdater,
  type LoadHotUpdaterResult,
} from "./utils/load-hot-updater";

export interface ApiKeyCommandOptions {
  /** The server definition the command line names, such as `src/hotUpdater.ts`. */
  readonly serverPath?: string;
}

export interface ApiKeyListOptions extends ApiKeyCommandOptions {
  readonly json?: boolean;
}

export interface ApiKeyRevokeOptions extends ApiKeyCommandOptions {
  readonly yes?: boolean;
}

/** apiKeys()'s plugin id, which assembly reserves for the official plugin. */
const API_KEYS = "apiKeys";

const API_KEYS_IMPORT =
  'import { apiKeys } from "@hot-updater/server/plugins/api-keys"';

/** apiKeys()'s API over the server's database, and what closes it. */
interface ApiKeysSource {
  readonly apiKeys: ApiKeyManagementAPI;
  dispose(): Promise<void>;
}

/** The API of the apiKeys() a server definition runs. */
const definitionApiKeys = async (
  loaded: LoadHotUpdaterResult,
): Promise<ApiKeysSource> => {
  const apiKeys = loaded.hotUpdater.api[API_KEYS];
  if (apiKeys === undefined) {
    await loaded.dispose();
    throw new Error(
      `${path.relative(process.cwd(), loaded.absoluteConfigPath)} lists no apiKeys() in plugins. Add apiKeys() to its plugins (${API_KEYS_IMPORT}).`,
    );
  }
  return {
    apiKeys: apiKeys as ApiKeyManagementAPI,
    dispose: loaded.dispose,
  };
};

/**
 * apiKeys()'s API, over the server definition `serverPath` names, else the
 * server hot-updater.config.ts describes when it sets `database`, else a
 * server project's `src/hotUpdater.*` or `src/db.*`.
 */
const openApiKeys = async (
  serverPath: string | undefined,
): Promise<ApiKeysSource> => {
  const cwd = process.cwd();
  if (serverPath?.trim()) {
    return definitionApiKeys(await loadHotUpdater(serverPath, { cwd }));
  }
  const config = await loadConfig(null);
  if (config.database !== undefined) {
    const server = await loadServer(config);
    // standaloneRepository's plugins run on the server, whose admin API
    // serves no API key routes.
    if (server.api === undefined) {
      await server.dispose();
      throw new Error(
        "API keys live in the server's database, and hot-updater.config.ts reaches the server through standaloneRepository's admin API, which serves no API key routes. Run hot-updater api-key <command> <path-to-server-definition> in the server project, such as src/hotUpdater.ts, or use a hot-updater.config.ts whose database is the server's adapter.",
      );
    }
    const apiKeys = server.api[API_KEYS];
    if (apiKeys === undefined) {
      await server.dispose();
      throw new Error(
        `hot-updater.config.ts lists no apiKeys() in plugins. Add apiKeys() to plugins, the same plugin your server runs (${API_KEYS_IMPORT}). A managed config gets it from the provider's plugins.`,
      );
    }
    return {
      apiKeys: apiKeys as ApiKeyManagementAPI,
      dispose: server.dispose,
    };
  }
  if (findDefaultConfigPaths(cwd).length > 0) {
    return definitionApiKeys(await loadHotUpdater("", { cwd }));
  }
  throw new Error(
    "Set database and plugins in hot-updater.config.ts, or pass the path to your server definition, such as src/hotUpdater.ts.",
  );
};

/**
 * Runs `run` over apiKeys()'s API, reports a failure with exit code 1, and
 * closes what it opened.
 */
const withApiKeys = async (
  options: ApiKeyCommandOptions,
  run: (apiKeys: ApiKeyManagementAPI) => Promise<void>,
): Promise<void> => {
  let source: ApiKeysSource | undefined;
  try {
    source = await openApiKeys(options.serverPath);
    await run(source.apiKeys);
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await source?.dispose();
  }
};

const formatList = (records: readonly ApiKeyMetadata[]): string => {
  if (records.length === 0) return ui.muted("(no API keys)");

  return ui.table(
    [
      { key: "id", label: "ID", format: ui.id },
      { key: "name", label: "Name" },
      { key: "prefix", label: "Prefix", format: ui.muted },
      {
        key: "status",
        label: "Status",
        format: (value: string) =>
          value.trim() === "active" ? ui.success(value) : ui.danger(value),
      },
      { key: "created", label: "Created", format: ui.muted },
    ],
    records.map((record) => ({
      created: new Date(record.created_at_ms).toISOString(),
      id: record.id,
      name: record.name,
      prefix: record.prefix,
      status: record.revoked_at_ms === null ? "active" : "revoked",
    })),
  );
};

export const handleApiKeyCreate = async (
  name: string,
  options: ApiKeyCommandOptions = {},
): Promise<void> => {
  printBanner();
  await withApiKeys(options, async (apiKeys) => {
    const created = await apiKeys.create({ name });
    p.log.message(
      ui.block("API key created", [
        ui.kv("Name", created.record.name),
        ui.kv("ID", ui.id(created.record.id)),
        ui.kv("API key", ui.warning(created.apiKey)),
      ]),
    );
    p.log.warn("Save this API key now. It will not be shown again.");
  });
};

export const handleApiKeyList = async (
  options: ApiKeyListOptions = {},
): Promise<void> => {
  if (!options.json) printBanner();
  await withApiKeys(options, async (apiKeys) => {
    const records = [...(await apiKeys.list())].sort(
      (left, right) => right.created_at_ms - left.created_at_ms,
    );
    if (options.json) {
      console.log(JSON.stringify(records, null, 2));
    } else {
      p.log.message(formatList(records));
    }
  });
};

/**
 * Whether to revoke: `-y`, or the user's answer. Without a terminal to ask
 * in, it exits 1; a declined or cancelled prompt exits 2.
 */
const confirmRevoke = async (
  id: string,
  yes: boolean | undefined,
): Promise<boolean> => {
  if (yes) return true;
  const message = `Revoke API key ${id}?`;
  if (!process.stdin.isTTY) {
    p.log.error(`${message} Re-run with -y in a non-interactive shell.`);
    process.exitCode = 1;
    return false;
  }
  const confirmed = await p.confirm({ initialValue: false, message });
  if (p.isCancel(confirmed) || !confirmed) {
    process.exitCode = 2;
    return false;
  }
  return true;
};

export const handleApiKeyRevoke = async (
  id: string,
  options: ApiKeyRevokeOptions = {},
): Promise<void> => {
  printBanner();
  if (!(await confirmRevoke(id, options.yes))) return;
  await withApiKeys(options, async (apiKeys) => {
    const revoked = await apiKeys.revoke({ id });
    if (revoked === null) {
      throw new Error(`API key "${id}" was not found.`);
    }
    p.log.message(
      ui.block("API key revoked", [
        ui.kv("Name", revoked.name),
        ui.kv("ID", ui.id(revoked.id)),
      ]),
    );
  });
};
