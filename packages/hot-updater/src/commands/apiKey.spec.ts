import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import {
  assembleServer,
  loadConfig,
  type ServerDefinition,
} from "@hot-updater/cli-tools";
import {
  type AnyHotUpdaterPlugin,
  createMemoryAdapter,
  type DatabaseAdapter,
  type EngineDatabase,
  type RemoteDatabase,
} from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import {
  type ApiKeyManagementAPI,
  type ApiKeyMetadata,
  apiKeys,
  insights,
} from "@hot-updater/server/plugins";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  handleApiKeyCreate,
  handleApiKeyList,
  handleApiKeyRevoke,
} from "./apiKey";
import {
  findDefaultConfigPaths,
  loadHotUpdater,
  type LoadHotUpdaterResult,
} from "./utils/load-hot-updater";

const { confirm, log, printBanner } = vi.hoisted(() => ({
  confirm: vi.fn(),
  log: {
    error: vi.fn(),
    message: vi.fn(),
    warn: vi.fn(),
  },
  printBanner: vi.fn(),
}));

// The server assembles for real: only the config and the prompts are mocked.
vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  loadConfig: vi.fn(),
  p: {
    confirm,
    isCancel: vi.fn(() => false),
    log,
  },
}));

vi.mock("@/utils/printBanner", () => ({ printBanner }));

vi.mock("./utils/load-hot-updater", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./utils/load-hot-updater")>()),
  findDefaultConfigPaths: vi.fn(() => []),
  loadHotUpdater: vi.fn(),
}));

const API_KEYS_ERROR =
  'hot-updater.config.ts lists no apiKeys() in plugins. Add apiKeys() to plugins, the same plugin your server runs (import { apiKeys } from "hot-updater/plugins").';
const STANDALONE_ERROR =
  "API keys live in the server's database, and hot-updater.config.ts reaches the server through standaloneRepository's admin API, which serves no API key routes. Run hot-updater api-key <command> <path-to-server-definition> in the server project, such as src/hotUpdater.ts, or use a hot-updater.config.ts whose database is the server's adapter.";
const NOTHING_FOUND_ERROR =
  "Set database and plugins in hot-updater.config.ts, or pass the path to your server definition, such as src/hotUpdater.ts.";

/** A database whose tables outlive each command that opens it, as a server's do. */
const createDatabase = (
  adapter: DatabaseAdapter = createMemoryAdapter(),
): EngineDatabase & { dispose: ReturnType<typeof vi.fn> } => ({
  name: "memory",
  adapter,
  dispose: vi.fn(async () => {}),
});

let database: ReturnType<typeof createDatabase>;

/** hot-updater.config.ts with `database` and `plugins`. */
const configure = (config: {
  readonly database?: EngineDatabase | RemoteDatabase;
  readonly plugins?: readonly AnyHotUpdaterPlugin[];
}) => {
  vi.mocked(loadConfig).mockResolvedValue({ plugins: [], ...config } as never);
};

/** apiKeys()'s API over the configured database's tables, to seed and read them. */
const keysOf = (adapter = database.adapter): ApiKeyManagementAPI =>
  assembleServer({
    database: { name: "memory", adapter },
    plugins: [apiKeys()],
  }).api["apiKeys"] as ApiKeyManagementAPI;

/** A server definition at `file`, as `loadHotUpdater` loads it. */
const definitionAt = (
  file: string,
  plugins: readonly AnyHotUpdaterPlugin[],
  definitionDatabase: EngineDatabase = createDatabase(),
): LoadHotUpdaterResult & { dispose: ReturnType<typeof vi.fn> } => ({
  hotUpdater: createHotUpdater({
    database: definitionDatabase,
    plugins: [...plugins],
    ...(plugins.some(({ provides }) => provides?.clientAuth)
      ? {}
      : { clientAccess: "public" }),
  } as Parameters<typeof createHotUpdater>[0]) as unknown as ServerDefinition,
  adapterName: definitionDatabase.name,
  absoluteConfigPath: path.join(process.cwd(), file),
  dispose: vi.fn(async () => {}),
});

const messages = () =>
  log.message.mock.calls.map(([text]) =>
    stripVTControlCharacters(String(text)),
  );

/** Runs `run` with stdin a terminal, or not. */
const withTTY = async (isTTY: boolean, run: () => Promise<void>) => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", {
    value: isTTY,
    configurable: true,
  });
  try {
    await run();
  } finally {
    if (descriptor === undefined) {
      delete (process.stdin as { isTTY?: boolean }).isTTY;
    } else {
      Object.defineProperty(process.stdin, "isTTY", descriptor);
    }
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  database = createDatabase();
  configure({ database, plugins: [insights(), apiKeys()] });
  vi.mocked(findDefaultConfigPaths).mockReturnValue([]);
});

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe("hot-updater api-key over hot-updater.config.ts", () => {
  it("creates a key through the config's apiKeys(), prints its plaintext once, and closes the database", async () => {
    await handleApiKeyCreate("Production app");

    expect(printBanner).toHaveBeenCalledOnce();
    const [record] = await keysOf().list();
    expect(record?.name).toBe("Production app");
    const printed = messages().join("\n");
    expect(printed).toContain("API key created");
    const apiKey = /API key:\s+(\S+)/u.exec(printed)?.[1];
    expect(apiKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(printed.split(apiKey!).length - 1).toBe(1);
    expect(JSON.stringify(record)).not.toContain(apiKey);
    expect(log.warn).toHaveBeenCalledWith(
      "Save this API key now. It will not be shown again.",
    );
    expect(database.dispose).toHaveBeenCalledOnce();
    expect(process.exitCode).toBeUndefined();
  });

  it("lists JSON metadata newest first, without hashes, plaintext, or the banner", async () => {
    const older = await keysOf().create({ name: "Older" });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const newer = await keysOf().create({ name: "Newer" });
    const output = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleApiKeyList({ json: true });

    const json = String(output.mock.calls[0]?.[0]);
    expect((JSON.parse(json) as ApiKeyMetadata[]).map(({ id }) => id)).toEqual([
      newer.record.id,
      older.record.id,
    ]);
    expect(json).not.toContain("hash");
    expect(json).not.toContain(older.apiKey);
    expect(printBanner).not.toHaveBeenCalled();
    expect(database.dispose).toHaveBeenCalledOnce();
  });

  it("lists a table, or says there are no keys", async () => {
    await handleApiKeyList();
    expect(messages()).toEqual(["(no API keys)"]);

    const created = await keysOf().create({ name: "Production app" });
    await keysOf().revoke({ id: created.record.id });
    log.message.mockClear();
    await handleApiKeyList();

    expect(messages()[0]).toMatch(
      new RegExp(
        `${created.record.id}\\s*│ Production app\\s*│ ${created.apiKey.slice(0, 6)}\\s*│ revoked`,
        "u",
      ),
    );
  });

  it("revokes a key with -y without asking", async () => {
    const created = await keysOf().create({ name: "Production app" });

    await handleApiKeyRevoke(created.record.id, { yes: true });

    expect(confirm).not.toHaveBeenCalled();
    await expect(keysOf().list()).resolves.toMatchObject([
      { id: created.record.id, revoked_at_ms: expect.any(Number) },
    ]);
    expect(messages()[0]).toContain("API key revoked");
    expect(database.dispose).toHaveBeenCalledOnce();
  });

  it("asks before revoking in a terminal, and exits 2 when declined", async () => {
    const created = await keysOf().create({ name: "Production app" });
    const message = `Revoke API key ${created.record.id}?`;

    await withTTY(true, async () => {
      confirm.mockResolvedValueOnce(false);
      await handleApiKeyRevoke(created.record.id);
      expect(process.exitCode).toBe(2);
      expect(loadConfig).not.toHaveBeenCalled();

      process.exitCode = undefined;
      confirm.mockResolvedValueOnce(true);
      await handleApiKeyRevoke(created.record.id);
    });

    expect(confirm).toHaveBeenCalledWith({ initialValue: false, message });
    expect(process.exitCode).toBeUndefined();
    await expect(keysOf().list()).resolves.toMatchObject([
      { id: created.record.id, revoked_at_ms: expect.any(Number) },
    ]);
  });

  it("needs -y to revoke without a terminal, before it opens anything", async () => {
    await withTTY(false, () => handleApiKeyRevoke("api-key-id"));

    expect(log.error).toHaveBeenCalledWith(
      "Revoke API key api-key-id? Re-run with -y in a non-interactive shell.",
    );
    expect(process.exitCode).toBe(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it("fails to revoke a key it does not have, and still closes the database", async () => {
    await handleApiKeyRevoke("api-missing", { yes: true });

    expect(log.error).toHaveBeenCalledWith(
      'API key "api-missing" was not found.',
    );
    expect(process.exitCode).toBe(1);
    expect(database.dispose).toHaveBeenCalledOnce();
  });

  it("reports a failed creation and closes the database", async () => {
    await handleApiKeyCreate("   ");

    expect(log.error).toHaveBeenCalledWith(
      "API key names must contain 1-64 visible characters.",
    );
    expect(process.exitCode).toBe(1);
    expect(database.dispose).toHaveBeenCalledOnce();
  });

  it("needs apiKeys() in the config's plugins, the plugin the server runs", async () => {
    configure({ database, plugins: [insights()] });

    await handleApiKeyList();

    expect(log.error).toHaveBeenCalledWith(API_KEYS_ERROR);
    expect(process.exitCode).toBe(1);
    expect(database.dispose).toHaveBeenCalledOnce();
  });

  it("points a config that reaches the server through standaloneRepository at the server project", async () => {
    const remote = {
      name: "standalone",
      core: assembleServer({ database: createDatabase() }).core,
      fetchAdmin: vi.fn(async () => new Response(null, { status: 404 })),
      dispose: vi.fn(async () => {}),
    } satisfies RemoteDatabase;
    configure({ database: remote, plugins: [insights(), apiKeys()] });

    await handleApiKeyCreate("Production app");

    expect(log.error).toHaveBeenCalledWith(STANDALONE_ERROR);
    expect(process.exitCode).toBe(1);
    expect(remote.fetchAdmin).not.toHaveBeenCalled();
    expect(remote.dispose).toHaveBeenCalledOnce();
  });
});

describe("hot-updater api-key over a server definition", () => {
  it("manages the keys of the definition the command line names, without loading hot-updater.config.ts", async () => {
    const definitionDatabase = createDatabase();
    const loaded = definitionAt(
      "server/hotUpdater.ts",
      [apiKeys()],
      definitionDatabase,
    );
    vi.mocked(loadHotUpdater).mockResolvedValue(loaded);

    await handleApiKeyCreate("Server app", {
      serverPath: "server/hotUpdater.ts",
    });

    expect(loadHotUpdater).toHaveBeenCalledWith("server/hotUpdater.ts", {
      cwd: process.cwd(),
    });
    expect(loadConfig).not.toHaveBeenCalled();
    await expect(
      keysOf(definitionDatabase.adapter).list(),
    ).resolves.toMatchObject([{ name: "Server app" }]);
    expect(loaded.dispose).toHaveBeenCalledOnce();
    expect(process.exitCode).toBeUndefined();
  });

  it("needs apiKeys() in the definition's plugins", async () => {
    const loaded = definitionAt(path.join("src", "hotUpdater.ts"), [
      insights(),
    ]);
    vi.mocked(loadHotUpdater).mockResolvedValue(loaded);

    await handleApiKeyRevoke("api-key-id", {
      serverPath: "src/hotUpdater.ts",
      yes: true,
    });

    expect(log.error).toHaveBeenCalledWith(
      `${path.join("src", "hotUpdater.ts")} lists no apiKeys() in plugins. Add apiKeys() to its plugins (import { apiKeys } from "@hot-updater/server/plugins").`,
    );
    expect(process.exitCode).toBe(1);
    expect(loaded.dispose).toHaveBeenCalledOnce();
  });

  it("uses src/hotUpdater.ts or src/db.ts when hot-updater.config.ts names no database", async () => {
    configure({});
    const loaded = definitionAt(path.join("src", "db.ts"), [apiKeys()]);
    vi.mocked(findDefaultConfigPaths).mockReturnValue([
      loaded.absoluteConfigPath,
    ]);
    vi.mocked(loadHotUpdater).mockResolvedValue(loaded);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleApiKeyList({ json: true });

    expect(loadHotUpdater).toHaveBeenCalledWith("", { cwd: process.cwd() });
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual([]);
    expect(loaded.dispose).toHaveBeenCalledOnce();
  });

  it("says what to set when there is no database and no server definition", async () => {
    configure({});

    await handleApiKeyList();

    expect(log.error).toHaveBeenCalledWith(NOTHING_FOUND_ERROR);
    expect(process.exitCode).toBe(1);
    expect(loadHotUpdater).not.toHaveBeenCalled();
  });
});
