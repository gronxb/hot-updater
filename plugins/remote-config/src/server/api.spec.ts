import { createPluginTestHarness } from "@hot-updater/test-utils";
import { describe, expect, it } from "vitest";

import { remoteConfig } from "./index";
import type { RemoteConfigTemplate } from "./template";
import { RemoteConfigValidationError } from "./template";

const greeting = (text: string): RemoteConfigTemplate => ({
  conditions: [
    { name: "iOS", rules: [{ type: "platform", platforms: ["ios"] }] },
  ],
  parameters: {
    greeting: {
      valueType: "STRING",
      defaultValue: { value: text },
      conditionalValues: { iOS: { value: `${text} from iOS` } },
    },
  },
});

const start = async () => {
  let clock = 1_000;
  const harness = await createPluginTestHarness(remoteConfig(), {
    now: () => clock,
  });
  return {
    ...harness,
    advance: (ms: number) => {
      clock += ms;
    },
  };
};

describe("remoteConfig() API", () => {
  it("starts empty at version 0, so devices keep their in-app defaults", async () => {
    const { api } = await start();
    expect(await api.getActive()).toEqual({
      version: 0,
      template: { conditions: [], parameters: {} },
      updatedAtMs: null,
    });
    expect(await api.resolve({ platform: "ios" })).toEqual({
      version: 0,
      values: {},
    });
    expect(await api.listVersions()).toEqual({ versions: [] });
  });

  it("publishes versions from the one an edit started on, and refuses a stale one", async () => {
    const { api, advance } = await start();
    expect(
      await api.publish({
        template: greeting("Hi"),
        baseVersion: 0,
        description: "  First  ",
      }),
    ).toEqual({
      status: "published",
      version: {
        version: 1,
        description: "First",
        updateType: "PUBLISH",
        rollbackSource: null,
        createdAtMs: 1_000,
      },
    });
    advance(1_000);
    expect(
      await api.publish({ template: greeting("Hello"), baseVersion: 1 }),
    ).toMatchObject({ status: "published", version: { version: 2 } });
    // Another editor still started from version 1.
    expect(
      await api.publish({ template: greeting("Hey"), baseVersion: 1 }),
    ).toEqual({ status: "conflict", currentVersion: 2 });

    expect(await api.getActive()).toEqual({
      version: 2,
      template: greeting("Hello"),
      updatedAtMs: 2_000,
    });
    expect(await api.resolve({ platform: "ios" })).toEqual({
      version: 2,
      values: { greeting: "Hello from iOS" },
    });
    expect(await api.resolve({ platform: "android" })).toEqual({
      version: 2,
      values: { greeting: "Hello" },
    });
  });

  it("lets only one of two concurrent publishes from one version win", async () => {
    const { api } = await start();
    const results = await Promise.all([
      api.publish({ template: greeting("A"), baseVersion: 0 }),
      api.publish({ template: greeting("B"), baseVersion: 0 }),
    ]);
    expect(results.map(({ status }) => status).sort()).toEqual([
      "conflict",
      "published",
    ]);
    expect((await api.getActive()).version).toBe(1);
  });

  it("throws the validation issues of an invalid template and stores nothing", async () => {
    const { api } = await start();
    await expect(
      api.publish({
        template: { parameters: { x: { valueType: "NUMBER" } } },
        baseVersion: 0,
      }),
    ).rejects.toBeInstanceOf(RemoteConfigValidationError);
    await expect(
      api.publish({ template: {}, baseVersion: -1 }),
    ).rejects.toThrow("baseVersion");
    expect((await api.getActive()).version).toBe(0);
  });

  it("rolls back by publishing a copy of an earlier version", async () => {
    const { api } = await start();
    await api.publish({ template: greeting("One"), baseVersion: 0 });
    await api.publish({ template: greeting("Two"), baseVersion: 1 });

    expect(await api.rollback({ version: 1, baseVersion: 2 })).toMatchObject({
      status: "published",
      version: {
        version: 3,
        updateType: "ROLLBACK",
        rollbackSource: 1,
        description: "Rollback to version 1",
      },
    });
    expect((await api.getActive()).template).toEqual(greeting("One"));
    expect(await api.rollback({ version: 9, baseVersion: 3 })).toEqual({
      status: "not_found",
    });
    expect(await api.rollback({ version: 2, baseVersion: 2 })).toEqual({
      status: "conflict",
      currentVersion: 3,
    });
  });

  it("pages versions newest first, and reads one with its template", async () => {
    const { api } = await start();
    for (let version = 0; version < 5; version += 1) {
      await api.publish({
        template: greeting(`v${version + 1}`),
        baseVersion: version,
      });
    }
    const first = await api.listVersions({ limit: 2 });
    expect(first.versions.map(({ version }) => version)).toEqual([5, 4]);
    const second = await api.listVersions({ limit: 2, cursor: first.next! });
    expect(second.versions.map(({ version }) => version)).toEqual([3, 2]);
    expect(await api.getVersion(3)).toMatchObject({
      version: 3,
      template: greeting("v3"),
    });
    expect(await api.getVersion(42)).toBeNull();
    await expect(api.listVersions({ limit: 0 })).rejects.toThrow("limit");
  });

  it("answers a device's fetch with one keyed read, then from memory for five seconds", async () => {
    const { api, advance, measureReads } = await start();
    await api.publish({ template: greeting("Hi"), baseVersion: 0 });

    const first = await measureReads(() => api.resolve({ platform: "ios" }));
    expect(first.result.values).toEqual({ greeting: "Hi from iOS" });
    expect(first.adapter).toEqual({ gets: 1, keys: 1, queries: 0, rows: 0 });

    const cached = await measureReads(() =>
      api.resolve({ platform: "android" }),
    );
    expect(cached.adapter).toEqual({ gets: 0, keys: 0, queries: 0, rows: 0 });

    advance(5_000);
    const expired = await measureReads(() => api.resolve({ platform: "ios" }));
    expect(expired.adapter).toEqual({ gets: 1, keys: 1, queries: 0, rows: 0 });

    // A publish on this server answers its next fetch with the new template.
    await api.publish({ template: greeting("Yo"), baseVersion: 1 });
    expect((await api.resolve({ platform: "ios" })).values).toEqual({
      greeting: "Yo from iOS",
    });
  });
});
