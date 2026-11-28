import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ConfigEnv, Plugin, UserConfig } from "vite";
import { afterEach, describe, expect, it } from "vitest";

import {
  createHostedConsolePlugins,
  createLocalConsoleModulesPlugin,
} from "./vite-internal";

const temporaryDirectories: string[] = [];

const createTemporaryDirectory = () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hot-updater-console-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("hosted console Vite modules", () => {
  it("generates the router shim and route tree in the host cache", () => {
    const root = createTemporaryDirectory();
    const plugin = createHostedConsolePlugins({})[0] as Plugin;
    const config = plugin.config as (
      config: UserConfig,
      environment: ConfigEnv,
    ) => UserConfig | undefined;

    const resolvedConfig = config(
      { root },
      { command: "build", mode: "production" },
    );

    const oxc = resolvedConfig?.oxc as
      | { jsx?: { development?: boolean } }
      | undefined;
    expect(oxc?.jsx?.development).toBe(false);

    const shimFile = path.join(root, ".hot-updater/console/router.ts");
    expect(readFileSync(shimFile, "utf8")).toContain(
      '"virtual:hot-updater-console/package-router"',
    );
    // TanStack Start reads the request middleware from the same directory.
    expect(
      readFileSync(path.join(root, ".hot-updater/console/start.ts"), "utf8"),
    ).toBe(
      'export { startInstance } from "virtual:hot-updater-console/package-start";\n',
    );

    const resolveId = plugin.resolveId as (id: string) => string | undefined;
    expect(resolveId("virtual:hot-updater-console/route-tree")).toBe(
      path.join(root, ".hot-updater/console/routeTree.gen.ts"),
    );
  });

  it("statically imports host config and auth modules", () => {
    const root = createTemporaryDirectory();
    const plugin = createHostedConsolePlugins({
      auth: "src/auth.ts",
      config: "src/config.ts",
    })[0] as Plugin;
    const config = plugin.config as (
      config: UserConfig,
      environment: ConfigEnv,
    ) => UserConfig | undefined;
    config({ root }, { command: "build", mode: "production" });

    const resolveId = plugin.resolveId as (id: string) => string | undefined;
    const load = plugin.load as (id: string) => string | undefined;
    const configId = resolveId("virtual:hot-updater-console/config");
    const authId = resolveId("virtual:hot-updater-console/auth");

    expect(configId).toBe("\0virtual:hot-updater-console/config");
    expect(authId).toBe("\0virtual:hot-updater-console/auth");

    const context = { addWatchFile() {} };
    expect(load.call(context, configId as string)).toContain(
      JSON.stringify(path.join(root, "src/config.ts")),
    );
    expect(load.call(context, authId as string)).toContain(
      JSON.stringify(path.join(root, "src/auth.ts")),
    );
  });
});

describe("the console's config module", () => {
  const configModule = (plugin: Plugin) => {
    const resolveId = plugin.resolveId as (id: string) => string | undefined;
    const load = plugin.load as (id: string) => string | undefined;
    return load.call(
      { addWatchFile() {} },
      resolveId("virtual:hot-updater-console/config")!,
    );
  };

  it("gives a hosted console the host's config, never cli-tools", () => {
    const root = createTemporaryDirectory();
    const plugin = createHostedConsolePlugins({})[0] as Plugin;
    const config = plugin.config as (
      config: UserConfig,
      environment: ConfigEnv,
    ) => UserConfig | undefined;
    config({ root }, { command: "build", mode: "production" });

    // cli-tools' native bindings and unconfig never reach a hosted build.
    expect(configModule(plugin)).toBe(
      `export { default } from ${JSON.stringify(path.join(root, "console.config.ts"))};`,
    );
  });

  it("gives the local console hot-updater.config.ts, as the CLI that runs it loads it", () => {
    expect(configModule(createLocalConsoleModulesPlugin())).toContain(
      'import { loadConfig } from "@hot-updater/cli-tools";',
    );
  });
});

describe("the console's request middleware modules", () => {
  it("gives a hosted console the package's start and no local guard", () => {
    const root = createTemporaryDirectory();
    const plugin = createHostedConsolePlugins({})[0] as Plugin;
    const config = plugin.config as (
      config: UserConfig,
      environment: ConfigEnv,
    ) => UserConfig | undefined;
    config({ root }, { command: "build", mode: "production" });
    const resolveId = plugin.resolveId as (id: string) => string | undefined;
    const load = plugin.load as (id: string) => string | undefined;

    expect(load(resolveId("virtual:hot-updater-console/package-start")!)).toBe(
      `export { startInstance } from ${JSON.stringify(path.resolve(import.meta.dirname, "start.ts"))};`,
    );
    expect(load(resolveId("virtual:hot-updater-console/request-guard")!)).toBe(
      "export default undefined;",
    );
  });

  it("gives the local console the guard over the session hot-updater console passes", () => {
    const plugin = createLocalConsoleModulesPlugin();
    const resolveId = plugin.resolveId as (id: string) => string | undefined;
    const load = plugin.load as (id: string) => string | undefined;

    const source = load(
      resolveId("virtual:hot-updater-console/request-guard")!,
    );

    expect(source).toContain(
      JSON.stringify(
        path.resolve(import.meta.dirname, "lib/server/local-console.ts"),
      ),
    );
    expect(source).toContain(
      "let session = process.env[LOCAL_CONSOLE_SESSION_ENV] || undefined;",
    );
    expect(source).toContain("checkHost: !import.meta.env.DEV,");
  });
});

describe("hosted console defaults", () => {
  it("reads console.config.ts and console.auth.ts beside hot-updater.config.ts, which the CLI reads", () => {
    const root = createTemporaryDirectory();
    const plugin = createHostedConsolePlugins({})[0] as Plugin;
    const config = plugin.config as (
      config: UserConfig,
      environment: ConfigEnv,
    ) => UserConfig | undefined;
    config({ root }, { command: "build", mode: "production" });
    const resolveId = plugin.resolveId as (id: string) => string | undefined;
    const load = plugin.load as (id: string) => string | undefined;
    const context = { addWatchFile() {} };

    expect(
      load.call(context, resolveId("virtual:hot-updater-console/config")!),
    ).toContain(JSON.stringify(path.join(root, "console.config.ts")));
    expect(
      load.call(context, resolveId("virtual:hot-updater-console/auth")!),
    ).toContain(JSON.stringify(path.join(root, "console.auth.ts")));
  });
});

describe("local console Vite modules", () => {
  it("loads hot-updater.config.ts's database, storage, and plugins, without accessing the app signer", () => {
    const plugin = createLocalConsoleModulesPlugin();
    const resolveId = plugin.resolveId as (id: string) => string | undefined;
    const load = plugin.load as (id: string) => string | undefined;
    const configId = resolveId("virtual:hot-updater-console/config");

    const source = load(configId as string);

    expect(source).toContain("const config = await loadConfig(null);");
    expect(source).toContain("database: config.database,");
    expect(source).toContain("storage: config.storage,");
    expect(source).toContain("plugins: config.plugins,");
    expect(source).toContain("gitUrl: config.console.gitUrl,");
    expect(source).not.toContain("channelLinkPrefix");
    expect(source).toContain(
      "Set database in hot-updater.config.ts: the database your server runs on",
    );
    expect(source).toContain(
      "Set storage in hot-updater.config.ts: where your server stores bundles",
    );
    expect(source).not.toContain("config.server");
    expect(source).not.toContain("config.signing");
    expect(source).not.toContain("privateKeyPath");
    expect(source).not.toContain("getPublicKey");
    expect(source).not.toContain("sign(");
  });
});
