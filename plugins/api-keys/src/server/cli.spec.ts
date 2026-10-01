import {
  createEngine,
  createMemoryAdapter,
  type CoreReader,
} from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import { apiKeys } from "./index";

/** The apiKeys() plugin's API over a memory adapter, as a server runs it. */
const assemble = () => {
  const plugin = apiKeys();
  const engine = createEngine(
    { name: "memory", adapter: createMemoryAdapter() },
    { plugins: [plugin] },
  );
  return plugin.init({
    db: engine.database(plugin),
    core: {} as CoreReader,
    now: Date.now,
  }).api;
};

describe("apiKeys() CLI metadata", () => {
  it("gives the CLI only the client credential: hot-updater api-key is built in", () => {
    expect(Object.keys(apiKeys().cli ?? {})).toEqual(["clientCredential"]);
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
