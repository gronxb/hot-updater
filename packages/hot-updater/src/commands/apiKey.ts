import { p } from "@hot-updater/cli-tools";

import { printBanner } from "@/utils/printBanner";

import { ui } from "../utils/cli-ui";
import {
  type ApiKeyManagementAPI,
  type ApiKeyMetadata,
  loadHotUpdater,
} from "./utils/load-hot-updater";

export interface ApiKeyCommandOptions {
  readonly configPath?: string;
}

export interface ApiKeyListOptions extends ApiKeyCommandOptions {
  readonly json?: boolean;
}

export interface ApiKeyRevokeOptions extends ApiKeyCommandOptions {
  readonly yes?: boolean;
}

const requireApiKeys = (value: unknown): ApiKeyManagementAPI => {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof Reflect.get(value, "create") !== "function" ||
    typeof Reflect.get(value, "list") !== "function" ||
    typeof Reflect.get(value, "revoke") !== "function"
  ) {
    throw new Error(
      "API key management requires a direct database config created by @hot-updater/server. Remote standaloneRepository configs are not supported.",
    );
  }
  return value as ApiKeyManagementAPI;
};

const withApiKeys = async <T>(
  options: ApiKeyCommandOptions,
  run: (apiKeys: ApiKeyManagementAPI) => Promise<T>,
): Promise<T> => {
  const loaded = await loadHotUpdater(options.configPath ?? "");
  try {
    return await run(requireApiKeys(loaded.hotUpdater.apiKeys));
  } finally {
    await loaded.dispose();
  }
};

const formatCreatedAt = (createdAtMs: number): string =>
  new Date(createdAtMs).toISOString();

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
      created: formatCreatedAt(record.created_at_ms),
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

const confirmRevoke = async (
  id: string,
  yes: boolean | undefined,
): Promise<void> => {
  if (yes) return;
  const message = `Revoke API key ${id}?`;
  if (!process.stdin.isTTY) {
    p.log.error(`${message} Re-run with -y in a non-interactive shell.`);
    process.exit(1);
  }
  const confirmed = await p.confirm({ initialValue: false, message });
  if (p.isCancel(confirmed) || !confirmed) process.exit(2);
};

export const handleApiKeyRevoke = async (
  id: string,
  options: ApiKeyRevokeOptions = {},
): Promise<void> => {
  printBanner();
  await confirmRevoke(id, options.yes);
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
