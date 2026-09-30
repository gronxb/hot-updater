import type {
  PluginCli,
  PluginCommandUi,
} from "@hot-updater/plugin-core/server-plugin";

import type {
  ApiKeyManagementAPI,
  ApiKeyMetadata,
  CreatedApiKey,
} from "./apiKeys";

/** The part of the apiKeys() API the CLI uses. */
export interface ApiKeysCliApi extends ApiKeyManagementAPI {
  provision(input: {
    readonly existingApiKey?: string;
    readonly name: string;
  }): Promise<CreatedApiKey>;
}

/** The environment variable init stores the app's API key in. */
export const API_KEY_ENV = "HOT_UPDATER_API_KEY";

/** A new API key: 32 random bytes, base64url, as the plugin creates them. */
const generateApiKey = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

const formatList = (
  ui: PluginCommandUi,
  records: readonly ApiKeyMetadata[],
): string =>
  records.length === 0
    ? ui.muted("(no API keys)")
    : ui.table(
        [
          { key: "id", label: "ID", format: ui.id },
          { key: "name", label: "Name" },
          { key: "prefix", label: "Prefix", format: ui.muted },
          {
            key: "status",
            label: "Status",
            format: (value) =>
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

/**
 * `hot-updater api-key create|list|revoke`, and the API key that init
 * provisions for an app, sent in `headerName`.
 */
export const apiKeysCli = (headerName: string): PluginCli<ApiKeysCliApi> => ({
  commands: [
    {
      name: "api-key",
      description: "Manage API keys",
      commands: [
        {
          name: "create",
          description: "Create an API key",
          options: [
            {
              flags: "--name <name>",
              description: "name used to identify the API key",
              required: true,
            },
          ],
          async run({ api, options, ui }) {
            const created = await api.create({ name: String(options.name) });
            ui.message(
              ui.block("API key created", [
                ui.kv("Name", created.record.name),
                ui.kv("ID", ui.id(created.record.id)),
                ui.kv("API key", ui.warning(created.apiKey)),
              ]),
            );
            ui.warn("Save this API key now. It will not be shown again.");
          },
        },
        {
          name: "list",
          description: "List API keys",
          options: [
            { flags: "--json", description: "output API key metadata as JSON" },
          ],
          async run({ api, options, ui }) {
            const records = [...(await api.list())].sort(
              (left, right) => right.created_at_ms - left.created_at_ms,
            );
            if (options.json) ui.print(JSON.stringify(records, null, 2));
            else ui.message(formatList(ui, records));
          },
        },
        {
          name: "revoke",
          description: "Revoke an API key",
          arguments: [{ name: "id", description: "API key id" }],
          options: [
            { flags: "-y, --yes", description: "skip confirmation prompt" },
          ],
          async run({ api, args, options, ui }) {
            const id = String(args.id);
            if (!options.yes) await ui.confirm(`Revoke API key ${id}?`);
            const revoked = await api.revoke({ id });
            if (revoked === null) {
              throw new Error(`API key "${id}" was not found.`);
            }
            ui.message(
              ui.block("API key revoked", [
                ui.kv("Name", revoked.name),
                ui.kv("ID", ui.id(revoked.id)),
              ]),
            );
          },
        },
      ],
    },
  ],
  clientCredential: {
    label: "API key",
    header: headerName,
    env: API_KEY_ENV,
    generate: generateApiKey,
    provision: async (api, { existing, name }) =>
      (
        await api.provision({
          ...(existing === undefined ? {} : { existingApiKey: existing }),
          name,
        })
      ).apiKey,
  },
});
