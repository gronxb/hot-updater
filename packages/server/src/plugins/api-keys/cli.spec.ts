import {
  type ApiKeysCliApi,
  apiKeysCli,
} from "@hot-updater/plugin-api-keys/internal";
import { createMemoryAdapter } from "@hot-updater/plugin-core/internal";
import { describe, expect, it, vi } from "vitest";

import { createDatabasePluginApis } from "../../assembly/databasePlugins";
import type { PluginCommand, PluginCommandUi } from "../definePlugin";
import { apiKeys, type ApiKeyMetadata } from "./index";

/** A UI that keeps what the command writes, unstyled. */
const createUi = () => {
  const output = { messages: [] as string[], warnings: [] as string[] };
  const printed: string[] = [];
  const ui: PluginCommandUi = {
    block: (heading, lines) => [heading, ...lines].join("\n"),
    kv: (label, value) => `${label}: ${value}`,
    table: (columns, rows) =>
      rows
        .map((row) => columns.map(({ key }) => row[key]).join(" | "))
        .join("\n"),
    id: (value) => value,
    muted: (value) => value,
    success: (value) => value,
    danger: (value) => value,
    warning: (value) => value,
    message: (text) => output.messages.push(text),
    info: (text) => output.messages.push(text),
    warn: (text) => output.warnings.push(text),
    print: (text) => printed.push(text),
    confirm: vi.fn(async () => {}),
  };
  return { ui, output, printed };
};

const command = (name: string): PluginCommand<ApiKeysCliApi> => {
  const group = apiKeysCli("x-api-key").commands?.[0];
  const found = group?.commands?.find((candidate) => candidate.name === name);
  if (found?.run === undefined) throw new Error(`No ${name} command.`);
  return found;
};

/** The apiKeys() plugin's API over a memory adapter, as the CLI assembles it. */
const assemble = () =>
  createDatabasePluginApis({ name: "memory", adapter: createMemoryAdapter() }, [
    apiKeys(),
  ]).apiKeys;

describe("apiKeys() CLI commands", () => {
  it("adds `hot-updater api-key` with create, list, and revoke", () => {
    const [group] = apiKeysCli("x-api-key").commands ?? [];
    expect(group?.name).toBe("api-key");
    expect(group?.commands?.map(({ name }) => name)).toEqual([
      "create",
      "list",
      "revoke",
    ]);
    expect(apiKeys().cli?.commands?.map(({ name }) => name)).toEqual([
      "api-key",
    ]);
  });

  it("creates a key and prints its plaintext exactly once", async () => {
    const api = assemble();
    const { ui, output } = createUi();

    await command("create").run!({
      api,
      args: {},
      options: { name: "Production app" },
      ui,
    });

    const [record] = await api.list();
    expect(record?.name).toBe("Production app");
    const printed = output.messages.join("\n");
    const apiKey = /API key: (\S+)/u.exec(printed)?.[1];
    expect(apiKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(printed.split(apiKey!).length - 1).toBe(1);
    expect(JSON.stringify(record)).not.toContain(apiKey);
    expect(output.warnings).toEqual([
      "Save this API key now. It will not be shown again.",
    ]);
  });

  it("lists JSON metadata newest first, without hashes or plaintext", async () => {
    const api = assemble();
    const older = await api.create({ name: "Older" });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const newer = await api.create({ name: "Newer" });
    const { ui, printed } = createUi();

    await command("list").run!({ api, args: {}, options: { json: true }, ui });

    const json = printed.join("\n");
    const records = JSON.parse(json) as ApiKeyMetadata[];
    expect(records.map(({ id }) => id)).toEqual([
      newer.record.id,
      older.record.id,
    ]);
    expect(json).not.toContain("hash");
    expect(json).not.toContain(older.apiKey);
  });

  it("lists a table, or says there are no keys", async () => {
    const api = assemble();
    const empty = createUi();
    await command("list").run!({
      api,
      args: {},
      options: {},
      ui: empty.ui,
    });
    expect(empty.output.messages).toEqual(["(no API keys)"]);

    const created = await api.create({ name: "Production app" });
    await api.revoke({ id: created.record.id });
    const listed = createUi();
    await command("list").run!({
      api,
      args: {},
      options: {},
      ui: listed.ui,
    });
    expect(listed.output.messages[0]).toContain(
      `${created.record.id} | Production app | ${created.apiKey.slice(0, 6)} | revoked`,
    );
  });

  it("confirms before revoking unless --yes is set", async () => {
    const api = assemble();
    const created = await api.create({ name: "Production app" });
    const { ui, output } = createUi();

    await command("revoke").run!({
      api,
      args: { id: created.record.id },
      options: {},
      ui,
    });

    expect(ui.confirm).toHaveBeenCalledWith(
      `Revoke API key ${created.record.id}?`,
    );
    await expect(api.list()).resolves.toMatchObject([
      { id: created.record.id, revoked_at_ms: expect.any(Number) },
    ]);
    expect(output.messages[0]).toContain("API key revoked");

    const skipped = createUi();
    await command("revoke").run!({
      api,
      args: { id: created.record.id },
      options: { yes: true },
      ui: skipped.ui,
    });
    expect(skipped.ui.confirm).not.toHaveBeenCalled();
  });

  it("fails to revoke a key it does not have", async () => {
    const { ui } = createUi();
    await expect(
      command("revoke").run!({
        api: assemble(),
        args: { id: "api-missing" },
        options: { yes: true },
        ui,
      }),
    ).rejects.toThrow('API key "api-missing" was not found.');
  });

  it("gives init the app's key: a saved one again, else a new one", async () => {
    const credential = apiKeys({ headerName: "X-Hot-Updater-Key" }).cli
      ?.clientCredential;
    expect(credential).toMatchObject({
      label: "API key",
      header: "x-hot-updater-key",
      env: "HOT_UPDATER_API_KEY",
    });
    const api = assemble();
    const created = await credential!.provision(api, { name: "Init" });
    expect(created).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    await expect(
      credential!.provision(api, { existing: created, name: "Init again" }),
    ).resolves.toBe(created);
    await expect(api.list()).resolves.toHaveLength(1);
  });
});
