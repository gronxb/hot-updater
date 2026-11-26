import { SETTINGS_TABLE } from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import {
  setupDatabaseTestSuite,
  startHttpTestServer,
} from "@hot-updater/test-utils";
import { describe, expect, it } from "vitest";

import { createFakeGithub, FAKE_GITHUB } from "./github.fixture";
import {
  githubJsonDatabase,
  migrateGithubJsonDatabase,
} from "./githubJsonDatabase";
import {
  createGithubJsonStore,
  DEFAULT_DATABASE_PATH,
} from "./githubJsonStore";

const github = createFakeGithub();
const config = { ...FAKE_GITHUB, fetch: github.fetch };

setupDatabaseTestSuite({
  name: "githubJsonDatabase",
  migrate: () => migrateGithubJsonDatabase(config),
  createDatabase: () => githubJsonDatabase(config),
  // Every table but the settings, which the schema fence checks.
  reset: () => {
    const file = github.readJson(DEFAULT_DATABASE_PATH)!;
    const partitions = file.data as Record<string, unknown>;
    github.writeJson(DEFAULT_DATABASE_PATH, {
      revision: file.revision + 1,
      data: { [SETTINGS_TABLE.name]: partitions[SETTINGS_TABLE.name] },
    });
  },
  dispose: async (database) => {
    await database.dispose?.();
  },
  createHttpClient: (options) =>
    startHttpTestServer(
      createHotUpdater({ ...options, clientAccess: "public" }).handlers,
    ),
});

describe("githubJsonDatabase file", () => {
  const put = (id: string) => ({
    type: "put" as const,
    key: { pk: "items", sk: id },
    value: { id },
    condition: { exists: false },
  });

  it("applies a write on top of another process's commit instead of overwriting it", async () => {
    const shared = createFakeGithub();
    const options = { ...FAKE_GITHUB, fetch: shared.fetch };
    const first = createGithubJsonStore(options);
    const second = createGithubJsonStore(options);
    await first.write([put("a")]);
    // `second` has not read since `first` committed.
    await second.write([put("b")]);
    await first.write([put("c")]);

    expect(
      await second.get(["a", "b", "c"].map((sk) => ({ pk: "items", sk }))),
    ).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
    // The loser of a contested key is refused, not retried into a duplicate.
    expect(await second.write([put("a")])).toEqual({ ok: false, failedOp: 0 });
  });

  it("commits concurrent writes of one process together", async () => {
    const shared = createFakeGithub();
    const store = createGithubJsonStore({
      ...FAKE_GITHUB,
      fetch: shared.fetch,
    });
    await store.write([put("seed")]);
    const before = shared.commits();

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) => store.write([put(`k${index}`)])),
    );

    expect(results.every((result) => result.ok)).toBe(true);
    expect(shared.commits() - before).toBeLessThanOrEqual(2);
  });

  it("drops expired items with the next write, and keeps the rest", async () => {
    const shared = createFakeGithub();
    const store = createGithubJsonStore({
      ...FAKE_GITHUB,
      fetch: shared.fetch,
    });
    await store.write([
      { ...put("old"), expiresAt: Date.now() - 1 },
      { ...put("fresh"), expiresAt: Date.now() + 60_000 },
      put("forever"),
    ]);
    await store.write([put("next")]);

    expect(
      await store.get(
        ["old", "fresh", "forever", "next"].map((sk) => ({ pk: "items", sk })),
      ),
    ).toEqual([null, { id: "fresh" }, { id: "forever" }, { id: "next" }]);
  });
});
