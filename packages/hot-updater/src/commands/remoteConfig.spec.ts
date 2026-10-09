import fs from "node:fs/promises";
import os from "node:os";
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
  type EngineDatabase,
  type RemoteDatabase,
} from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import { insights } from "@hot-updater/server/plugins/insights";
import {
  remoteConfig,
  type RemoteConfigApi,
  type RemoteConfigTemplate,
} from "@hot-updater/server/plugins/remote-config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  handleRemoteConfigPreview,
  handleRemoteConfigPublish,
  handleRemoteConfigRollback,
  handleRemoteConfigShow,
  handleRemoteConfigVersions,
} from "./remoteConfig";
import { loadHotUpdater } from "./utils/load-hot-updater";

const { confirm, log, printBanner } = vi.hoisted(() => ({
  confirm: vi.fn(),
  log: {
    error: vi.fn(),
    info: vi.fn(),
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

const template: RemoteConfigTemplate = {
  conditions: [
    {
      name: "Beta channel",
      rules: [{ type: "channel", channels: ["beta"] }],
    },
  ],
  parameters: {
    welcome: {
      valueType: "STRING",
      defaultValue: { value: "Welcome" },
      conditionalValues: { "Beta channel": { value: "Welcome, tester" } },
    },
    max_items: {
      valueType: "NUMBER",
      defaultValue: { useInAppDefault: true },
    },
  },
};

const createDatabase = (): EngineDatabase & {
  dispose: ReturnType<typeof vi.fn>;
} => ({
  name: "memory",
  adapter: createMemoryAdapter(),
  dispose: vi.fn(async () => {}),
});

let database: ReturnType<typeof createDatabase>;
let directory: string;

const configure = (config: {
  readonly database?: EngineDatabase | RemoteDatabase;
  readonly plugins?: readonly AnyHotUpdaterPlugin[];
}) => {
  vi.mocked(loadConfig).mockResolvedValue({ plugins: [], ...config } as never);
};

/** remoteConfig()'s API over the configured database's tables, to seed and read them. */
const remoteConfigOf = (db: EngineDatabase = database): RemoteConfigApi =>
  assembleServer({
    database: { name: "memory", adapter: db.adapter },
    plugins: [remoteConfig()],
  }).api["remoteConfig"] as RemoteConfigApi;

/** A file in this test's directory holding `value` as JSON. */
const fileOf = async (name: string, value: unknown): Promise<string> => {
  const file = path.join(directory, name);
  await fs.writeFile(file, JSON.stringify(value));
  return file;
};

const messages = () =>
  log.message.mock.calls.map(([text]) =>
    stripVTControlCharacters(String(text)),
  );

/** What the command printed as JSON. */
const jsonOutput = () => {
  const output = vi.mocked(console.log).mock.calls.at(-1)?.[0];
  return JSON.parse(String(output)) as Record<string, unknown>;
};

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

/**
 * A self-hosted server with `plugins`, and a standaloneRepository whose admin
 * API is the server's real admin handler.
 */
const standaloneServer = (plugins: readonly AnyHotUpdaterPlugin[]) => {
  const serverDatabase = createDatabase();
  const hotUpdater = createHotUpdater({
    database: serverDatabase,
    plugins: [...plugins],
    ...(plugins.some(({ provides }) => provides?.clientAuth)
      ? {}
      : { clientAccess: "public" }),
  } as Parameters<typeof createHotUpdater>[0]);
  const remote = {
    name: "standalone",
    core: hotUpdater.core,
    fetchAdmin: vi.fn((adminPath: string, init?: RequestInit) =>
      hotUpdater.handlers.admin(
        new Request(`https://updates.example.com${adminPath}`, init),
      ),
    ),
    dispose: vi.fn(async () => {}),
  } satisfies RemoteDatabase;
  return { remote, serverDatabase };
};

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  database = createDatabase();
  configure({ database, plugins: [insights(), remoteConfig()] });
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "remote-config-cli-"));
});

afterEach(async () => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

describe("hot-updater remote-config over hot-updater.config.ts", () => {
  it("publishes a template file as the next version, shows it, and closes the database", async () => {
    const file = await fileOf("template.json", template);

    await handleRemoteConfigShow();
    expect(messages().join("\n")).toContain("Nothing is published yet.");

    await handleRemoteConfigPublish(file, {
      description: "Welcome copy",
      yes: true,
    });

    const active = await remoteConfigOf().getActive();
    expect(active.version).toBe(1);
    expect(active.template).toEqual(template);
    const printed = messages().join("\n");
    expect(printed).toContain("+ parameter welcome");
    expect(printed).toContain("+ condition Beta channel");
    expect(printed).toContain("Remote Config published");
    expect(confirm).not.toHaveBeenCalled();
    expect(database.dispose).toHaveBeenCalledTimes(2);
    expect(process.exitCode).toBeUndefined();

    log.message.mockClear();
    await handleRemoteConfigShow();
    const shown = messages().join("\n");
    expect(shown).toContain("Remote Config version 1");
    expect(shown).toMatch(
      /welcome\s*│ STRING\s*│ Welcome\s*│ Beta channel: Welcome, tester/u,
    );
    expect(shown).toMatch(/max_items\s*│ NUMBER\s*│ In-app default/u);
    expect(shown).toMatch(/Beta channel\s*│ Channel is beta/u);
  });

  it("publishes nothing when the template is the active one", async () => {
    await remoteConfigOf().publish({ template, baseVersion: 0 });
    const file = await fileOf("template.json", {
      // Another key order is the same template.
      parameters: template.parameters,
      conditions: template.conditions,
    });

    await handleRemoteConfigPublish(file, { json: true, yes: true });

    expect(jsonOutput()).toEqual({ status: "unchanged", version: 1 });
    expect((await remoteConfigOf().getActive()).version).toBe(1);
    expect(printBanner).not.toHaveBeenCalled();
  });

  it("publishes what show --json printed, refusing it once another version was published", async () => {
    await remoteConfigOf().publish({ template, baseVersion: 0 });
    await handleRemoteConfigShow({ json: true });
    const shown = jsonOutput();
    expect(shown).toMatchObject({ version: 1, template });
    const edited = {
      ...shown,
      template: {
        ...template,
        parameters: {
          ...template.parameters,
          welcome: {
            valueType: "STRING",
            defaultValue: { value: "Hello" },
          },
        },
      },
    };
    const file = await fileOf("edited.json", edited);

    await handleRemoteConfigPublish(file, { json: true, yes: true });
    expect(jsonOutput()).toMatchObject({
      status: "published",
      version: { version: 2, updateType: "PUBLISH" },
    });

    // The file still says it was read at version 1.
    edited.template.parameters.welcome.defaultValue.value = "Hi";
    await fs.writeFile(file, JSON.stringify(edited));
    await handleRemoteConfigPublish(file, { yes: true });

    expect(log.error).toHaveBeenCalledWith(
      "Remote Config version 2 was published after version 1. Run hot-updater remote-config show to see it, then publish again.",
    );
    expect(process.exitCode).toBe(1);
    expect((await remoteConfigOf().getActive()).version).toBe(2);
  });

  it("lists what an invalid template must fix, and publishes nothing", async () => {
    const file = await fileOf("invalid.json", {
      conditions: [],
      parameters: {
        welcome: { valueType: "STRING", defaultValue: { value: 1 } },
      },
    });

    await handleRemoteConfigPublish(file, { json: true, yes: true });

    expect(jsonOutput()).toMatchObject({
      status: "invalid",
      issues: [{ path: "parameters.welcome.defaultValue.value" }],
    });
    expect(process.exitCode).toBe(1);
    expect((await remoteConfigOf().getActive()).version).toBe(0);
  });

  it("shows the changes of a dry run and publishes nothing", async () => {
    await remoteConfigOf().publish({ template, baseVersion: 0 });
    const file = await fileOf("draft.json", {
      conditions: [],
      parameters: {
        welcome: { valueType: "STRING", defaultValue: { value: "Hello" } },
        banner: { valueType: "BOOLEAN", defaultValue: { value: "true" } },
      },
    });

    await handleRemoteConfigPublish(file, { dryRun: true });

    const printed = messages().join("\n");
    expect(printed).toContain("Changes from version 1");
    expect(printed).toContain("+ parameter banner");
    expect(printed).toContain("~ parameter welcome");
    expect(printed).toContain("- parameter max_items");
    expect(printed).toContain("- condition Beta channel");
    expect(log.info).toHaveBeenCalledWith(
      "Dry run: the template is valid. Nothing was published.",
    );
    expect(confirm).not.toHaveBeenCalled();
    expect((await remoteConfigOf().getActive()).version).toBe(1);
  });

  it("asks before publishing in a terminal, exits 2 when declined, and needs -y without one", async () => {
    const file = await fileOf("template.json", template);
    const message = "Publish this template as Remote Config version 1?";

    await withTTY(true, async () => {
      confirm.mockResolvedValueOnce(false);
      await handleRemoteConfigPublish(file);
    });
    expect(confirm).toHaveBeenCalledWith({ initialValue: false, message });
    expect(process.exitCode).toBe(2);

    process.exitCode = undefined;
    await withTTY(false, () => handleRemoteConfigPublish(file));
    expect(log.error).toHaveBeenCalledWith(
      `${message} Re-run with -y in a non-interactive shell.`,
    );
    expect(process.exitCode).toBe(1);
    expect((await remoteConfigOf().getActive()).version).toBe(0);
    expect(database.dispose).toHaveBeenCalledTimes(2);
  });

  it("rolls back to an earlier version, and fails for one that does not exist", async () => {
    const api = remoteConfigOf();
    await api.publish({ template, baseVersion: 0 });
    await api.publish({
      template: { conditions: [], parameters: {} },
      baseVersion: 1,
    });

    await handleRemoteConfigRollback(1, { yes: true });

    const active = await api.getActive();
    expect(active.version).toBe(3);
    expect(active.template).toEqual(template);
    expect(messages().join("\n")).toContain("Rollback to v1");

    await handleRemoteConfigRollback(9, { yes: true });
    expect(log.error).toHaveBeenCalledWith(
      "Remote Config version 9 does not exist.",
    );
    expect(process.exitCode).toBe(1);
  });

  it("lists versions newest first, marking the active one", async () => {
    const api = remoteConfigOf();
    await api.publish({ template, baseVersion: 0, description: "First" });
    await api.rollback({ version: 1, baseVersion: 1 });

    await handleRemoteConfigVersions();

    const [table] = messages();
    expect(table).toMatch(/v2 \(active\)\s*│ Rollback to v1\s*│\s*│/u);
    expect(table).toMatch(/v1\s*│ Publish\s*│ First/u);

    await handleRemoteConfigVersions({ json: true, limit: 1 });
    expect(jsonOutput()).toMatchObject({
      versions: [{ version: 2 }],
      next: expect.any(String),
    });
  });

  it("previews a device's values from the active template or a draft file", async () => {
    await remoteConfigOf().publish({ template, baseVersion: 0 });

    await handleRemoteConfigPreview({
      json: true,
      platform: "ios",
      channel: "beta",
    });
    expect(jsonOutput()).toEqual({
      version: 1,
      parameters: {
        welcome: { value: "Welcome, tester", condition: "Beta channel" },
        max_items: { value: null, condition: null },
      },
    });

    const draft = await fileOf("draft.json", {
      conditions: [
        {
          name: "October",
          rules: [{ type: "dateTime", from: "2026-10-01T00:00:00Z" }],
        },
      ],
      parameters: {
        banner: {
          valueType: "STRING",
          defaultValue: { value: "None" },
          conditionalValues: { October: { value: "Autumn" } },
        },
      },
    });
    await handleRemoteConfigPreview({
      file: draft,
      at: "2026-10-09T00:00:00Z",
    });
    expect(messages().at(-1)).toMatch(/banner\s*│ Autumn\s*│ October/u);

    await handleRemoteConfigPreview({ file: draft, at: "October" });
    expect(log.error).toHaveBeenCalledWith(
      '--at takes an ISO 8601 date-time, such as 2026-10-01T09:00:00Z; got "October".',
    );
    expect(process.exitCode).toBe(1);
  });

  it("needs remoteConfig() in the config's plugins, the plugin the server runs", async () => {
    configure({ database, plugins: [insights()] });

    await handleRemoteConfigShow();

    expect(log.error).toHaveBeenCalledWith(
      'hot-updater.config.ts lists no remoteConfig() in plugins. Add remoteConfig() to plugins, the same plugin your server runs (import { remoteConfig } from "@hot-updater/server/plugins/remote-config"). A managed config gets it from the provider\'s plugins.',
    );
    expect(process.exitCode).toBe(1);
    expect(database.dispose).toHaveBeenCalledOnce();
  });
});

describe("hot-updater remote-config over standaloneRepository", () => {
  it("publishes, shows, and rolls back through the server's admin routes", async () => {
    const { remote, serverDatabase } = standaloneServer([remoteConfig()]);
    configure({ database: remote, plugins: [remoteConfig()] });
    const file = await fileOf("template.json", template);

    await handleRemoteConfigPublish(file, { yes: true });
    await handleRemoteConfigRollback(1, { yes: true, description: "Again" });
    await handleRemoteConfigShow({ json: true, versionNumber: 2 });

    expect(jsonOutput()).toMatchObject({
      version: 2,
      updateType: "ROLLBACK",
      rollbackSource: 1,
      description: "Again",
      template,
    });
    expect((await remoteConfigOf(serverDatabase).getActive()).version).toBe(2);
    expect(remote.fetchAdmin).toHaveBeenCalledWith(
      "/remote-config/template",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(remote.dispose).toHaveBeenCalledTimes(3);
    expect(process.exitCode).toBeUndefined();
  });

  it("reports the server's issues for a template only the server refuses", async () => {
    const { remote } = standaloneServer([remoteConfig()]);
    configure({ database: remote, plugins: [remoteConfig()] });
    const issues = [{ path: "parameters.x", message: "is not allowed." }];
    remote.fetchAdmin.mockImplementation(async (_adminPath, init) =>
      init?.method === "PUT"
        ? Response.json({ error: "invalid", issues }, { status: 400 })
        : Response.json({
            version: 0,
            template: { conditions: [], parameters: {} },
            updatedAtMs: null,
          }),
    );

    await handleRemoteConfigPublish(await fileOf("t.json", template), {
      json: true,
      yes: true,
    });

    expect(jsonOutput()).toEqual({ status: "invalid", issues });
    expect(process.exitCode).toBe(1);
  });

  it("says when the server runs without remoteConfig()", async () => {
    const { remote } = standaloneServer([]);
    configure({ database: remote, plugins: [remoteConfig()] });

    await handleRemoteConfigVersions();

    expect(log.error).toHaveBeenCalledWith(
      "The server runs without remoteConfig(): its admin API serves no Remote Config routes. Add remoteConfig() to the plugins of createHotUpdater on the server, and deploy it.",
    );
    expect(process.exitCode).toBe(1);
  });
});

describe("hot-updater remote-config over a server definition", () => {
  it("publishes through the definition the command line names, without loading hot-updater.config.ts", async () => {
    const definitionDatabase = createDatabase();
    const hotUpdater = createHotUpdater({
      database: definitionDatabase,
      plugins: [remoteConfig()],
      clientAccess: "public",
    });
    const dispose = vi.fn(async () => {});
    vi.mocked(loadHotUpdater).mockResolvedValue({
      hotUpdater: hotUpdater as unknown as ServerDefinition,
      adapterName: "memory",
      absoluteConfigPath: path.join(process.cwd(), "src", "hotUpdater.ts"),
      dispose,
    });

    await handleRemoteConfigPublish(await fileOf("t.json", template), {
      serverPath: "src/hotUpdater.ts",
      yes: true,
    });

    expect(loadConfig).not.toHaveBeenCalled();
    expect((await remoteConfigOf(definitionDatabase).getActive()).version).toBe(
      1,
    );
    expect(dispose).toHaveBeenCalledOnce();
  });
});
