import path from "node:path";

import { Command } from "@commander-js/extra-typings";
import { definePlugin, createMemoryAdapter } from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import { apiKeys } from "@hot-updater/server/plugins/api-keys";
import { insights } from "@hot-updater/server/plugins/insights";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadServerDefinition } from "../utils/loadServer";
import { PLUGIN_COMMANDS_HINT, registerPluginCommands } from "./pluginCommands";
import {
  findDefaultConfigPaths,
  importHotUpdater,
  isConfigFile,
  loadHotUpdater,
  type LoadHotUpdaterResult,
} from "./utils/load-hot-updater";

const cli = vi.hoisted(() => ({
  confirm: vi.fn(),
  loadConfig: vi.fn(),
  log: {
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    warn: vi.fn(),
  },
  printBanner: vi.fn(),
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  loadConfig: cli.loadConfig,
  p: {
    confirm: cli.confirm,
    isCancel: () => false,
    log: cli.log,
  },
}));

vi.mock("../utils/printBanner", () => ({ printBanner: cli.printBanner }));

vi.mock("../utils/loadServer", () => ({ loadServerDefinition: vi.fn() }));

vi.mock("./utils/load-hot-updater", () => ({
  findDefaultConfigPaths: vi.fn(() => []),
  importHotUpdater: vi.fn(),
  isConfigFile: vi.fn(() => false),
  loadHotUpdater: vi.fn(),
}));

const cwd = "/repo";

/** A plugin whose API counts and whose commands read and reset the count. */
const counter = (state = { count: 3 }) =>
  definePlugin({
    id: "counter",
    schemaVersion: "1",
    schema: {},
    init: () => ({
      api: {
        count: () => state.count,
        reset: () => {
          state.count = 0;
        },
      },
    }),
    cli: {
      commands: [
        {
          name: "counter",
          description: "Read the counter",
          commands: [
            {
              name: "show",
              description: "Print the count",
              arguments: [{ name: "label", description: "a label" }],
              options: [{ flags: "--json", description: "as JSON" }],
              async run({ api, args, options, ui }) {
                const label = String(args["label"]);
                ui.print(
                  options["json"]
                    ? JSON.stringify({ [label]: api.count() })
                    : `${label}: ${api.count()}`,
                );
              },
            },
            {
              name: "reset",
              description: "Reset the count",
              options: [{ flags: "-y, --yes", description: "skip" }],
              async run({ api, options, ui }) {
                if (!options["yes"]) await ui.confirm("Reset the counter?");
                api.reset();
              },
            },
          ],
        },
      ],
    },
  });

const serverConfig = (
  file: string,
  plugins: readonly ReturnType<typeof counter>[],
): LoadHotUpdaterResult => {
  const hotUpdater = createHotUpdater({
    database: { name: "memory", adapter: createMemoryAdapter() },
    plugins,
    clientAccess: "public",
  });
  return {
    hotUpdater,
    adapterName: hotUpdater.adapterName,
    absoluteConfigPath: path.join(cwd, file),
    dispose: vi.fn(async () => {}),
  };
};

/** The server definition hot-updater.config.ts points at, over `plugins`. */
const configuredServer = (
  plugins: readonly unknown[],
  dispose = vi.fn(async () => {}),
) => {
  cli.loadConfig.mockResolvedValue({ server: "/repo/hotUpdater.ts" });
  vi.mocked(loadServerDefinition).mockImplementation(async (file) => {
    // A plugin that provides clientAuth replaces clientAccess.
    const providesClientAuth = plugins.some(
      (plugin) =>
        (plugin as { provides?: { clientAuth?: true } }).provides
          ?.clientAuth === true,
    );
    const hotUpdater = createHotUpdater({
      database: { name: "memory", adapter: createMemoryAdapter() },
      plugins: plugins as readonly ReturnType<typeof counter>[],
      ...(providesClientAuth ? {} : { clientAccess: "public" as const }),
    } as Parameters<typeof createHotUpdater>[0]);
    return {
      kind: "definition",
      path: file,
      hotUpdater,
      plugins,
      dispose,
    } as unknown as Awaited<ReturnType<typeof loadServerDefinition>>;
  });
  return dispose;
};

const program = () => {
  const created = new Command().name("hot-updater").exitOverride();
  created
    .command("bundle")
    .command("list")
    .action(() => {});
  created
    .command("db")
    .command("migrate")
    .action(() => {});
  return created;
};

const argv = (...args: string[]) => ["node", "hot-updater", ...args];

const output = (created: Command) => {
  const written = { out: "", err: "" };
  created.configureOutput({
    writeOut: (text) => {
      written.out += text;
    },
    writeErr: (text) => {
      written.err += text;
    },
  });
  return written;
};

const printed = () => {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    lines.push(line);
  });
  return lines;
};

beforeEach(() => {
  vi.clearAllMocks();
  cli.loadConfig.mockResolvedValue({});
  vi.mocked(findDefaultConfigPaths).mockReturnValue([]);
  vi.mocked(isConfigFile).mockReturnValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("registerPluginCommands", () => {
  it("loads nothing for core commands and flags", async () => {
    for (const args of [["bundle", "list"], ["-V"], ["help", "db"]]) {
      await registerPluginCommands(program(), argv(...args), cwd);
    }
    expect(cli.loadConfig).not.toHaveBeenCalled();
    expect(importHotUpdater).not.toHaveBeenCalled();
    expect(loadHotUpdater).not.toHaveBeenCalled();
  });

  it("lists the plugins' commands in help, marked with their plugin", async () => {
    configuredServer([counter()]);
    const created = program();
    await registerPluginCommands(created, argv("--help"), cwd);

    const help = created.helpInformation();
    expect(help).toContain("Plugin commands:");
    expect(help).toMatch(/counter\s+Read the counter \(counter\)/u);
    expect(importHotUpdater).not.toHaveBeenCalled();
  });

  it("shows core commands and one hint when the project lists no plugins", async () => {
    const created = program();
    const written = output(created);
    await registerPluginCommands(created, argv(), cwd);

    expect(created.helpInformation()).not.toContain("Plugin commands:");
    created.outputHelp();
    expect(written.out).toContain(PLUGIN_COMMANDS_HINT);
  });

  it("says what the plugins add after an unknown command", async () => {
    configuredServer([counter()]);
    const created = program();
    const written = output(created);
    await registerPluginCommands(created, argv("bogus"), cwd);

    expect(() => created.parse(argv("bogus"))).toThrow();
    expect(written.err).toContain("error: unknown command 'bogus'");
    expect(written.err).toContain(
      "Plugin commands in hotUpdater.ts:\n  counter (counter)",
    );
  });

  it("runs a command over the server config the command line names", async () => {
    const loaded = serverConfig("src/server.ts", [counter()]);
    vi.mocked(isConfigFile).mockImplementation(
      (value) => value === "src/server.ts",
    );
    vi.mocked(loadHotUpdater).mockResolvedValue(loaded);
    const lines = printed();
    const created = program();
    const args = argv("counter", "show", "total", "src/server.ts", "--json");
    await registerPluginCommands(created, args, cwd);
    await created.parseAsync(args);

    expect(loadHotUpdater).toHaveBeenCalledWith("src/server.ts", { cwd });
    expect(lines).toEqual(['{"total":3}']);
    expect(cli.printBanner).not.toHaveBeenCalled();
    expect(loaded.dispose).toHaveBeenCalledOnce();
    expect(loadServerDefinition).not.toHaveBeenCalled();
  });

  it("runs a command over the server definition hot-updater.config.ts points at", async () => {
    const dispose = configuredServer([counter({ count: 7 })]);
    const lines = printed();
    const created = program();
    const args = argv("counter", "show", "total");
    await registerPluginCommands(created, args, cwd);
    await created.parseAsync(args);

    expect(loadServerDefinition).toHaveBeenCalledWith("/repo/hotUpdater.ts");
    expect(lines).toEqual(["total: 7"]);
    expect(cli.printBanner).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(importHotUpdater).not.toHaveBeenCalled();
  });

  it("falls back to the default server configs, past files without an instance", async () => {
    const loaded = serverConfig("src/db.ts", [counter()]);
    vi.mocked(findDefaultConfigPaths).mockReturnValue([
      "/repo/src/hotUpdater.ts",
      "/repo/src/db.ts",
    ]);
    vi.mocked(importHotUpdater).mockImplementation(async (file) =>
      file === "/repo/src/db.ts" ? loaded : undefined,
    );
    const lines = printed();
    const created = program();
    const args = argv("counter", "show", "total");
    await registerPluginCommands(created, args, cwd);
    await created.parseAsync(args);

    expect(lines).toEqual(["total: 3"]);
    expect(loaded.dispose).toHaveBeenCalledOnce();
  });

  it("runs over a server config the command line names past discovery", async () => {
    const discovered = serverConfig("src/db.ts", [counter({ count: 1 })]);
    const named = serverConfig("config/other.ts", [counter({ count: 2 })]);
    vi.mocked(findDefaultConfigPaths).mockReturnValue(["/repo/src/db.ts"]);
    vi.mocked(importHotUpdater).mockResolvedValue(discovered);
    vi.mocked(loadHotUpdater).mockResolvedValue(named);
    const lines = printed();
    const created = program();
    // Not a file yet, so discovery passes it over; the run still loads it.
    const args = argv("counter", "show", "total", "config/other.ts");
    await registerPluginCommands(created, args, cwd);
    await created.parseAsync(args);

    expect(loadHotUpdater).toHaveBeenCalledWith("config/other.ts", { cwd });
    expect(lines).toEqual(["total: 2"]);
    expect(discovered.dispose).toHaveBeenCalledOnce();
    expect(named.dispose).toHaveBeenCalledOnce();
  });

  it("does not load the definition the config points at again after the command line names it", async () => {
    configuredServer([counter()]);
    const named = serverConfig("hotUpdater.ts", []);
    vi.mocked(isConfigFile).mockImplementation(
      (value) => value === "hotUpdater.ts",
    );
    vi.mocked(loadHotUpdater).mockResolvedValue(named);
    const created = program();
    const written = output(created);
    const args = argv("counter", "show", "total", "hotUpdater.ts");
    await registerPluginCommands(created, args, cwd);

    expect(() => created.parse(args)).toThrow();
    expect(written.err).toContain("error: unknown command 'counter'");
    // The process shares the module, so closing a second copy would close
    // the database of the one the command line named.
    expect(loadServerDefinition).not.toHaveBeenCalled();
    expect(named.dispose).not.toHaveBeenCalled();
  });

  it("finds no plugin commands through a standaloneRepository config, and says how to name a definition", async () => {
    const fetchAdmin = vi.fn(async () => new Response("41"));
    cli.loadConfig.mockResolvedValue({
      server: { name: "standalone", core: {}, fetchAdmin, storage: [] },
    });
    const created = program();
    const written = output(created);
    await registerPluginCommands(created, argv("counter", "show"), cwd);

    expect(() => created.parse(argv("counter", "show"))).toThrow();
    expect(written.err).toContain("error: unknown command 'counter'");
    expect(written.err).toContain(PLUGIN_COMMANDS_HINT);
    expect(loadServerDefinition).not.toHaveBeenCalled();
    expect(fetchAdmin).not.toHaveBeenCalled();
  });

  it("confirms before an irreversible step", async () => {
    const state = { count: 5 };
    const loaded = serverConfig("src/db.ts", [counter(state)]);
    vi.mocked(findDefaultConfigPaths).mockReturnValue(["/repo/src/db.ts"]);
    vi.mocked(importHotUpdater).mockResolvedValue(loaded);
    const run = async () => {
      const created = program();
      const args = argv("counter", "reset");
      await registerPluginCommands(created, args, cwd);
      await created.parseAsync(args);
    };

    const tty = process.stdin.isTTY;
    try {
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: false,
      });
      await run();
      expect(process.exitCode).toBe(1);
      expect(cli.log.error).toHaveBeenCalledWith(
        "Reset the counter? Re-run with -y in a non-interactive shell.",
      );
      expect(state.count).toBe(5);

      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: true,
      });
      process.exitCode = undefined;
      cli.confirm.mockResolvedValue(false);
      await run();
      expect(process.exitCode).toBe(2);
      expect(state.count).toBe(5);

      process.exitCode = undefined;
      cli.confirm.mockResolvedValue(true);
      await run();
      expect(process.exitCode).toBeUndefined();
      expect(state.count).toBe(0);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: tty,
      });
    }
  });

  it("leaves out a plugin command that a core command shadows", async () => {
    const shadowing = definePlugin({
      id: "shadow",
      schemaVersion: "1",
      schema: {},
      init: () => ({ api: {} }),
      cli: {
        commands: [{ name: "bundle", description: "Shadowed", async run() {} }],
      },
    });
    configuredServer([counter(), shadowing]);
    const created = program();
    await registerPluginCommands(created, argv("--help"), cwd);

    const help = created.helpInformation();
    expect(help).toMatch(/counter\s+Read the counter \(counter\)/u);
    expect(help).not.toContain("Shadowed");
  });

  it("lists the commands of Hot Updater's own plugins", async () => {
    configuredServer([insights(), apiKeys()]);
    const created = program();
    await registerPluginCommands(created, argv("--help"), cwd);

    expect(created.helpInformation()).toMatch(/api-key\s+.*\(apiKeys\)/u);
  });

  it("refuses a plugin that takes a reserved id without being Hot Updater's own", async () => {
    configuredServer([{ ...counter(), id: "insights", namespace: false }]);
    const created = program();
    const written = output(created);
    await registerPluginCommands(created, argv("--help"), cwd);

    created.outputHelp();
    expect(written.out).toContain(
      'plugins[0] takes the id "insights", which is reserved for Hot Updater\'s insights() plugin',
    );
  });

  it("keeps help working when the plugin list fails to load", async () => {
    cli.loadConfig.mockResolvedValue({ server: "/repo/hotUpdater.ts" });
    vi.mocked(loadServerDefinition).mockRejectedValue(
      new Error("/repo/hotUpdater.ts must export hotUpdater"),
    );
    const created = program();
    const written = output(created);
    await registerPluginCommands(created, argv("--help"), cwd);

    created.outputHelp();
    expect(written.out).toContain(
      "Could not list plugin commands: /repo/hotUpdater.ts must export hotUpdater",
    );
  });
});
