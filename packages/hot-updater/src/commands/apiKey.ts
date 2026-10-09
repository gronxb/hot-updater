import { p } from "@hot-updater/cli-tools";
import type {
  ApiKeyManagementAPI,
  ApiKeyMetadata,
} from "@hot-updater/server/plugins/api-keys";

import { printBanner } from "@/utils/printBanner";

import { ui } from "../utils/cli-ui";
import {
  confirmAction,
  requirePlugin,
  withPluginServer,
} from "./utils/open-server";

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

const API_KEYS = {
  id: "apiKeys",
  call: "apiKeys()",
  importLine: 'import { apiKeys } from "hot-updater/plugins"',
  serverImportLine:
    'import { apiKeys } from "@hot-updater/server/plugins/api-keys"',
} as const;

/** Runs `run` over the API of the apiKeys() the server runs. */
const withApiKeys = (
  options: ApiKeyCommandOptions,
  run: (apiKeys: ApiKeyManagementAPI) => Promise<void>,
): Promise<void> =>
  withPluginServer(options.serverPath, async (server) => {
    // standaloneRepository's plugins run on the server, whose admin API
    // serves no API key routes.
    if (server.api === undefined) {
      throw new Error(
        "API keys live in the server's database, and hot-updater.config.ts reaches the server through standaloneRepository's admin API, which serves no API key routes. Run hot-updater api-key <command> <path-to-server-definition> in the server project, such as src/hotUpdater.ts, or use a hot-updater.config.ts whose database is the server's adapter.",
      );
    }
    requirePlugin(server, API_KEYS);
    await run(server.api[API_KEYS.id] as ApiKeyManagementAPI);
  });

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

export const handleApiKeyRevoke = async (
  id: string,
  options: ApiKeyRevokeOptions = {},
): Promise<void> => {
  printBanner();
  if (!(await confirmAction(`Revoke API key ${id}?`, options.yes))) return;
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
