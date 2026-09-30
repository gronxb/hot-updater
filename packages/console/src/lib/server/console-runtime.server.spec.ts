// @vitest-environment node

import { createStorageAdapter } from "@hot-updater/plugin-core";
import { createMemoryAdapter } from "@hot-updater/plugin-core/internal";
import { createHotUpdater } from "@hot-updater/server";
import { insights } from "@hot-updater/server/plugins/insights";
import { describe, expect, it, vi } from "vitest";

import type { HotUpdaterConsoleConfigSource } from "../../index";
import { resolveConsoleConfig } from "./console-runtime.server";

const configModule = vi.hoisted(() => ({
  source: undefined as HotUpdaterConsoleConfigSource | undefined,
}));

vi.mock("virtual:hot-updater-console/config", () => ({
  get default() {
    return configModule.source;
  },
}));

const request = new Request("https://console.example.com/");
const storage = createStorageAdapter({ name: "s3Storage", protocol: "s3" });

describe("Console config resolution", () => {
  it.each(["object", "callback"])(
    "reads a %s config's server definition: its database, storage, and plugins",
    async (sourceType) => {
      const database = { name: "memory", adapter: createMemoryAdapter() };
      const plugins = [insights()];
      const config = {
        server: createHotUpdater({
          database,
          storage: [storage],
          plugins,
          clientAccess: "public",
        }),
        gitUrl: "https://github.com/example/app",
      };
      const source = vi.fn(async () => config);
      configModule.source = sourceType === "object" ? config : source;

      await expect(resolveConsoleConfig(request)).resolves.toEqual({
        gitUrl: "https://github.com/example/app",
        database,
        storage: [storage],
        plugins,
      });
      if (sourceType === "callback") {
        expect(source).toHaveBeenCalledWith(request);
      }
    },
  );

  it("reaches a self-hosted server through standaloneRepository, whose plugins its /version lists", async () => {
    const server = {
      name: "standalone-repository",
      url: "https://updates.example.com/hot-updater/admin",
      core: {} as never,
      fetchAdmin: vi.fn(),
      storage: [storage],
    };
    configModule.source = { server };

    await expect(resolveConsoleConfig(request)).resolves.toEqual({
      database: server,
      storage: [storage],
    });
    expect(server.fetchAdmin).not.toHaveBeenCalled();
  });

  it("refuses a server that is neither", async () => {
    configModule.source = { server: { adapterName: "memory" } as never };

    await expect(resolveConsoleConfig(request)).rejects.toThrow(
      "The console's server must be your server definition",
    );
  });
});
