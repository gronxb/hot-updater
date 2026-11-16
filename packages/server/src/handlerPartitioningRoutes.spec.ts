import { DatabaseSync } from "node:sqlite";

import {
  createEngineDatabase,
  createSqlAdapter,
  SETTINGS_TABLE,
} from "@hot-updater/plugin-core";
import { createReleaseCatalogTestStorage } from "@hot-updater/test-utils";
import { sqliteExecutor } from "@hot-updater/test-utils/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PARTITIONING_REQUEST_TTL_MS } from "./core/catalogPartitioning";
import { createHotUpdater } from "./createHotUpdaterCore";
import { apiKeys } from "./plugins/api-keys";
import { createMigrator } from "./tooling.testFixtures";

const URL_ = "http://localhost/release-catalog-partitioning";

/**
 * A managed server's shape: client routes behind `apiKeys()`, no admin
 * mount used. The partitioning client route is public, and only a request
 * token stored through the database opens it.
 */
const open = async () => {
  const sqlite = new DatabaseSync(":memory:");
  const adapter = createSqlAdapter({ executor: sqliteExecutor(sqlite) });
  const server = createHotUpdater({
    database: createEngineDatabase({ adapter, name: "sqlite" }),
    plugins: [apiKeys()],
    storage: createReleaseCatalogTestStorage(),
  });
  await (await createMigrator(server).migrateToLatest()).execute();
  const switchValue = async () =>
    (await adapter.get(SETTINGS_TABLE, [["catalog.partitioning"]]))[0]?.value ??
    null;
  const post = (body: unknown) =>
    server.handlers.client(
      new Request(URL_, {
        method: "POST",
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
  return {
    server,
    post,
    sqlite,
    switchValue,
    close: () => sqlite.close(),
  };
};

describe("POST /release-catalog-partitioning on the client mount", () => {
  let env: Awaited<ReturnType<typeof open>>;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    env = await open();
  });
  afterEach(() => {
    vi.useRealTimers();
    env.close();
  });

  it("is public under clientAuth, and turns partitioning on with a stored token", async () => {
    const catalog = await env.server.handlers.client(
      new Request("http://localhost/release-catalogs/app-version/ios/p/1.0.0"),
    );
    expect(catalog.status).toBe(401);
    const token = await env.server.core.issueReleaseCatalogPartitioningToken();
    const response = await env.post({ token });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      data: { partitioning: "on", changed: true },
    });
    expect(await env.switchValue()).toBe("on");
  });

  it("answers missing, malformed, wrong, expired and used tokens the same way, and sets nothing", async () => {
    const answers: string[] = [];
    const record = async (response: Response) => {
      answers.push(
        `${response.status} ${response.headers.get("cache-control")} ${await response.text()}`,
      );
    };
    await record(await env.post(""));
    await record(await env.post("not json"));
    await record(await env.post({}));
    await record(await env.post({ token: 42 }));
    await record(await env.post({ token: "wrong" }));
    const expired =
      await env.server.core.issueReleaseCatalogPartitioningToken();
    vi.setSystemTime(Date.now() + PARTITIONING_REQUEST_TTL_MS);
    await record(await env.post({ token: expired }));
    expect(await env.switchValue()).toBeNull();

    const token = await env.server.core.issueReleaseCatalogPartitioningToken();
    expect((await env.post({ token })).status).toBe(200);
    await record(await env.post({ token }));

    expect(new Set(answers)).toEqual(
      new Set([
        `403 private, no-store ${JSON.stringify({
          code: "PARTITIONING_REQUEST_INVALID",
          error: "The partitioning request is not valid.",
        })}`,
      ]),
    );
  });

  it("serves no other method", async () => {
    const response = await env.server.handlers.client(new Request(URL_));
    expect(response.status).toBe(404);
  });
});

describe("/release-catalog-partitioning on the admin mount", () => {
  let env: Awaited<ReturnType<typeof open>>;
  beforeEach(async () => {
    env = await open();
  });
  afterEach(() => env.close());

  it("reads the status, and turns partitioning on once", async () => {
    const admin = (method: string) =>
      env.server.handlers.admin(new Request(URL_, { method }));
    expect(await (await admin("GET")).json()).toEqual({
      data: { switch: "off", table: "present" },
    });
    const first = await admin("POST");
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(await first.json()).toEqual({
      data: { partitioning: "on", changed: true },
    });
    expect(await (await admin("POST")).json()).toEqual({
      data: { partitioning: "on", changed: false },
    });
    expect(await (await admin("GET")).json()).toEqual({
      data: { switch: "on", table: "present" },
    });
  });

  it("refuses with 409 on a database without the table, and sets nothing", async () => {
    env.sqlite.exec("DROP TABLE release_catalog_partitions");
    const response = await env.server.handlers.admin(
      new Request(URL_, { method: "POST" }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "PARTITIONS_UNAVAILABLE",
    });
    expect(await env.switchValue()).toBeNull();
    expect(
      await (await env.server.handlers.admin(new Request(URL_))).json(),
    ).toEqual({ data: { switch: "off", table: "missing" } });
  });
});
