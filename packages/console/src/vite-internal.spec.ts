import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ConfigEnv, Plugin, UserConfig } from "vite";
import { afterEach, describe, expect, it } from "vitest";

import { createHostedConsolePlugins } from "./vite-internal";

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
