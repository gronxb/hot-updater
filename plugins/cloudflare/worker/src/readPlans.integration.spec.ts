import { createHotUpdater } from "@hot-updater/server";
import { insights } from "@hot-updater/server/plugins/insights";
import { env } from "cloudflare:test";
import { expect, inject, it } from "vitest";

import {
  createBundleEventRowFixture,
  createBundleFixture,
} from "../../../../packages/test-utils/src/databaseTestFixtures";
import { d1Database } from "../../src/worker";

it("reads only through declared indexes on D1, never a full scan or a sort", async () => {
  await env.DB.prepare(inject("prepareSql")).run();
  /** Each operation's reads, in the order the operations ran. */
  const reads = new Map<
    string,
    { readonly sql: string; readonly params: readonly unknown[] }[]
  >();
  let operation = "";
  const { core, api } = createHotUpdater({
    database: d1Database({
      prepare(sql) {
        return {
          bind(...params) {
            if (/^\s*SELECT\b/iu.test(sql)) {
              reads.get(operation)!.push({ sql, params });
            }
            return env.DB.prepare(sql).bind(...params);
          },
        };
      },
      batch: (statements) => env.DB.batch(statements as D1PreparedStatement[]),
    }),
    plugins: [insights()],
    clientAccess: "public",
  });
  /** Runs `run`, recording the reads it makes under `name`. */
  const measure = async <T>(name: string, run: () => Promise<T>) => {
    operation = name;
    reads.set(name, []);
    return run();
  };

  const event = createBundleEventRowFixture("11", 100);
  await measure("ensureChannel", () => core.ensureChannel("production"));
  const [deployed] = await measure("deploy", () =>
    core.deploy([
      {
        bundle: createBundleFixture("1"),
        release: {
          channel: "production",
          enabled: true,
          fingerprintHash: null,
          message: null,
          shouldForceUpdate: false,
          targetAppVersion: "1.0.0",
        },
      },
    ]),
  );
  await measure("insights.recordEvent", () => api.insights.recordEvent(event));
  await measure("getRelease", () => core.getRelease(deployed!.release!.id));
  await measure("listChannels", () => core.listChannels());
  await measure("insights.findLatestEvents", () =>
    api.insights.findLatestEvents({ installId: event.install_id }),
  );
  await measure("insights.countLatestEvents", () =>
    api.insights.countLatestEvents({
      platform: event.platform,
      channel: event.channel,
      sinceMs: 0,
    }),
  );

  for (const [name, statements] of reads) {
    expect(statements.length, name).toBeGreaterThan(0);
    for (const { sql, params } of statements) {
      const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...params)
        .all<{ detail: string }>();
      const details = plan.results.map(({ detail }) => detail);
      expect(
        details.filter((detail) => /^SCAN \S+$/u.test(detail)),
        `${name}: ${sql}`,
      ).toEqual([]);
      expect(details.join("\n"), `${name}: ${sql}`).not.toContain(
        "TEMP B-TREE",
      );
    }
  }
});
